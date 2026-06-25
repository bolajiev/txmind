import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { JITO_TIP_ACCOUNTS } from "./tips";

export interface BundleParams {
  transaction: VersionedTransaction;
  tipLamports: number;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  currentSlot?: number;
}

export interface BuiltBundle {
  // Serialized base58 transactions ready for Jito HTTP API [mainTx, tipTx]
  serializedTxs: string[];
  bundleId: string;
  tipLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  constructedAt: number;
  constructedSlot: number;
  signature: string;
  keypair: Keypair;
}

function getWalletKeypair(): Keypair {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(pk));
}

export async function buildBundle(params: BundleParams): Promise<BuiltBundle> {
  const keypair = getWalletKeypair();
  const tipAccountIndex = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[tipAccountIndex]);

  // Build tip transaction: transfer tipLamports to a Jito tip account
  const tipMsg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: params.recentBlockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: tipAccount,
        lamports: params.tipLamports,
      }),
    ],
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMsg);
  tipTx.sign([keypair]);

  const signature = bs58.encode(params.transaction.signatures[0]);
  const bundleId = `${signature.slice(0, 8)}-${Date.now()}`;

  return {
    serializedTxs: [
      bs58.encode(params.transaction.serialize()),
      bs58.encode(tipTx.serialize()),
    ],
    bundleId,
    tipLamports: params.tipLamports,
    blockhash: params.recentBlockhash,
    lastValidBlockHeight: params.lastValidBlockHeight,
    constructedAt: Date.now(),
    constructedSlot: params.currentSlot ?? 0,
    signature,
    keypair,
  };
}
