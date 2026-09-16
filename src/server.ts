import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────────
// We no longer need a custom smart contract! 
// Your personal wallet — receives the 5% platform fee
const PLATFORM_FEE_WALLET = new PublicKey(
  process.env.PLATFORM_FEE_WALLET ?? '9CCWeKbQhS6WGFGbgk68M9SDmT9B45C1gYPDo5PdSpWZ'
);
// Use mainnet-beta by default now!
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'GigSplit API is live on Mainnet ✅' });
});

// ─── SOLANA PAY: GET (wallet fetches label + icon) ───────────────────────────
app.get('/api/pay', (_req: Request, res: Response) => {
  res.status(200).json({
    label: 'GigSplit Payment',
    icon: 'https://gigsplit-backend.onrender.com/logo.png', 
  });
});

// ─── HELPER WEB PAGE FOR TESTING ON MOBILE ────────────────────────────────────
app.get('/pay-link', (req: Request, res: Response) => {
  const artist = req.query.artist;
  const amount = req.query.amount;
  const ref = req.query.reference ? `&reference=${req.query.reference}` : '';
  
  const rawApiUrl = `https://gigsplit-backend.onrender.com/api/pay?artist=${artist}&amount=${amount}${ref}`;
  const solanaUrl = `solana:${encodeURIComponent(rawApiUrl)}`;
  
  const phantomInnerUrl = `https://gigsplit-backend.onrender.com/pay-link-phantom?artist=${artist}&amount=${amount}${ref}`;
  const phantomBrowseUrl = `https://phantom.app/ul/browse/${encodeURIComponent(phantomInnerUrl)}`;
  
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; background: #0A0A0A; margin: 0; color: white; gap: 20px; }
          .btn { background: #9945FF; color: white; padding: 20px 40px; border-radius: 20px; text-decoration: none; font-size: 18px; font-weight: bold; box-shadow: 0 4px 14px rgba(153, 69, 255, 0.4); text-align: center; }
          .btn-outline { background: transparent; border: 2px solid #555; color: #ccc; }
          .sub { color: #888; font-size: 14px; text-align: center; max-width: 80%; }
        </style>
      </head>
      <body>
        <a class="btn" href="${phantomBrowseUrl}">Tap to Open in Phantom</a>
        <a class="btn btn-outline" href="${solanaUrl}">Open Default Wallet (Coinbase, etc)</a>
      </body>
    </html>
  `);
});

// ─── PHANTOM IN-APP BROWSER TRAMPOLINE ────────────────────────────────────────
app.get('/pay-link-phantom', (req: Request, res: Response) => {
  const artist = req.query.artist;
  const amount = req.query.amount;
  const ref = req.query.reference ? `&reference=${req.query.reference}` : '';
  
  const rawApiUrl = `https://gigsplit-backend.onrender.com/api/pay?artist=${artist}&amount=${amount}${ref}`;
  const solanaUrl = `solana:${encodeURIComponent(rawApiUrl)}`;
  
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; background: #0A0A0A; margin: 0; color: white; }
          .btn { background: #1B4332; color: #86EFAC; padding: 20px 40px; border-radius: 20px; text-decoration: none; font-size: 20px; font-weight: bold; text-align: center; border: 2px solid #86EFAC; }
        </style>
        <script>
          window.onload = () => { setTimeout(() => { window.location.href = "${solanaUrl}"; }, 500); };
        </script>
      </head>
      <body>
        <a class="btn" href="${solanaUrl}">Confirm Transaction</a>
        <p style="color:#888; margin-top: 20px;">Loading payment...</p>
      </body>
    </html>
  `);
});

// ─── SOLANA PAY: POST (wallet sends payer address, gets back transaction) ────
app.post('/api/pay', async (req: Request, res: Response) => {
  try {
    const { account } = req.body;
    const artistQuery = req.query.artist as string;
    const amountQuery = req.query.amount as string; // in SOL
    const referenceQuery = req.query.reference as string; // standard Solana Pay reference

    if (!account)       return res.status(400).json({ error: 'Missing payer account' });
    if (!artistQuery)   return res.status(400).json({ error: 'Missing artist wallet' });
    if (!amountQuery)   return res.status(400).json({ error: 'Missing amount' });

    const payerPubkey  = new PublicKey(account);
    const artistPubkey = new PublicKey(artistQuery);
    
    // Calculate split securely on the backend
    const amountLamports = BigInt(Math.round(parseFloat(amountQuery) * 1e9));
    const artistLamports = (amountLamports * 95n) / 100n;
    const feeLamports    = amountLamports - artistLamports;

    // Create native Solana transfers (No smart contract needed!)
    const transferArtist = SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: artistPubkey,
      lamports: artistLamports,
    });
    const transferFee = SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: PLATFORM_FEE_WALLET,
      lamports: feeLamports,
    });

    // Append tracking reference to the first instruction so the frontend can find it
    if (referenceQuery) {
      transferArtist.keys.push({ pubkey: new PublicKey(referenceQuery), isSigner: false, isWritable: false });
    }

    const transaction = new Transaction().add(transferArtist, transferFee);
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.feePayer    = payerPubkey;
    transaction.recentBlockhash = blockhash;

    const serialized = transaction.serialize({ requireAllSignatures: false });

    return res.status(200).json({
      transaction: serialized.toString('base64'),
      message: `Pay ${amountQuery} SOL via GigSplit`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to build transaction' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`GigSplit backend running on port ${PORT}`);
});
