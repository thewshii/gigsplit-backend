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
// Your deployed GigSplit smart contract address
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? '6cQUNfcpM7Q9iLyQPWjV2VcTDL6QyQwmCpJjKZpqpemX'
);
// Your personal wallet — receives the 5% platform fee
const PLATFORM_FEE_WALLET = new PublicKey(
  process.env.PLATFORM_FEE_WALLET ?? '767Va4iPX5NNVyP1afPjn6aJqEhVTgGydaTwZB1Kxqss'
);
// Use environment variable for RPC — defaults to devnet
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// ─── ANCHOR DISCRIMINATOR ──────────────────────────────────────────────────────
// Anchor uses the first 8 bytes of SHA256("global:<function_name>") as a prefix
function getDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'GigSplit API is live ✅' });
});

// ─── SOLANA PAY: GET (wallet fetches label + icon) ───────────────────────────
app.get('/api/pay', (_req: Request, res: Response) => {
  res.status(200).json({
    label: 'GigSplit Payment',
    icon: 'https://gigsplit-backend.onrender.com/logo.png', // replace with your logo URL
  });
});

// ─── HELPER WEB PAGE FOR TESTING ON MOBILE ────────────────────────────────────
app.get('/pay-link', (req: Request, res: Response) => {
  const artist = req.query.artist;
  const amount = req.query.amount;
  
  // The Solana Pay spec requires the URL after "solana:" to be fully URL-encoded!
  const rawApiUrl = `https://gigsplit-backend.onrender.com/api/pay?artist=${artist}&amount=${amount}`;
  const solanaUrl = `solana:${encodeURIComponent(rawApiUrl)}`;
  const phantomUniversalUrl = `https://phantom.app/ul/v1/pay?url=${encodeURIComponent(rawApiUrl)}`;
  
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
        <a class="btn" href="${solanaUrl}">Tap to Open in Phantom</a>
        <a class="btn btn-outline" href="${phantomUniversalUrl}">Use Alternate Link (if first fails)</a>
        <p class="sub">Make sure you have the Phantom app installed on this device.</p>
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

    if (!account)       return res.status(400).json({ error: 'Missing payer account' });
    if (!artistQuery)   return res.status(400).json({ error: 'Missing artist wallet' });
    if (!amountQuery)   return res.status(400).json({ error: 'Missing amount' });

    const payerPubkey  = new PublicKey(account);
    const artistPubkey = new PublicKey(artistQuery);
    const amountLamports = BigInt(Math.round(parseFloat(amountQuery) * 1e9));

    // Build Anchor instruction data: 8-byte discriminator + u64 amount (little-endian)
    const discriminator = getDiscriminator('split_payment');
    const amountBuffer  = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amountLamports);
    const data = Buffer.concat([discriminator, amountBuffer]);

    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payerPubkey,         isSigner: true,  isWritable: true  },
        { pubkey: artistPubkey,        isSigner: false, isWritable: true  },
        { pubkey: PLATFORM_FEE_WALLET, isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const transaction = new Transaction().add(instruction);
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
