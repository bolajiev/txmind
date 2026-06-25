import { Connection, PublicKey } from "@solana/web3.js";

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.devnet.solana.com";
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(RPC_ENDPOINT, "confirmed");
  }
  return connection;
}

export interface BlockhashResult {
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function fetchBlockhash(): Promise<BlockhashResult> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  return { blockhash, lastValidBlockHeight };
}

export function getConnectionInstance(): Connection {
  return getConnection();
}
