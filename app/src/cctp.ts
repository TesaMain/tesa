// Circle CCTP V2 real: USDC de Ethereum Sepolia para Solana devnet.
// burn no Sepolia (depositForBurn, Fast Transfer) → atestação da Circle (Iris) → receiveMessage na
// Solana, que cunha USDC direto na conta de token do cofre. O cofre não assina nada.
// Endereços: developers.circle.com/cctp/references/contract-addresses e .../solana-programs.
// Contas do receiveMessage: exemplo oficial circlefin/solana-cctp-contracts, examples/v2/solana.ts.
import { createPublicClient, createWalletClient, http, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const CCTP = {
  iris: "https://iris-api-sandbox.circle.com",
  fastFinality: 1000,
  sepolia: {
    domain: 0,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Hex,
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Hex,
    explorerTx: (h: string) => `https://sepolia.etherscan.io/tx/${h}`,
    explorerAddress: (a: string) => `https://sepolia.etherscan.io/address/${a}`,
  },
  solana: {
    domain: 5,
    usdcMint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    messageTransmitter: new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"),
    tokenMessengerMinter: new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"),
  },
};

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RECEIVE_MESSAGE_DISC = Uint8Array.from([0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19]);
/** TokenMessenger: 8 (discriminador) + denylister, owner, pending_owner (3×32) + u32 + u8. */
const FEE_RECIPIENT_OFFSET = 8 + 32 * 3 + 4 + 1;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const APPROVE_CAP = 1_000_000n * 1_000_000n; // 1.000.000 USDC
const TOKEN_MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
const pda = (programId: PublicKey, ...seeds: (string | Uint8Array | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? new TextEncoder().encode(s) : s instanceof PublicKey ? s.toBytes() : s)),
    programId
  )[0];
const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ------------------------------------------------------------------ Ethereum Sepolia

export function sepoliaClients(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const transport = http(CCTP.sepolia.rpc);
  return {
    account,
    pub: createPublicClient({ chain: sepolia, transport }),
    wallet: createWalletClient({ account, chain: sepolia, transport }),
  };
}

export async function sepoliaBalances(privateKey: Hex) {
  const { account, pub } = sepoliaClients(privateKey);
  const [eth, usdc] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: CCTP.sepolia.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  return { address: account.address, eth, usdc };
}

/** Taxa do Fast Transfer em bps (Iris) e o maxFee correspondente para `amount` (unidades de 6 casas). */
export async function fastTransferMaxFee(amount: bigint) {
  const res = await fetch(`${CCTP.iris}/v2/burn/USDC/fees/${CCTP.sepolia.domain}/${CCTP.solana.domain}`);
  const fees = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
  const bps = fees.find((f) => f.finalityThreshold === CCTP.fastFinality)?.minimumFee ?? 1;
  // Arredonda para cima e dobra a folga: a taxa é cobrada no destino e não pode passar de maxFee.
  return { bps, maxFee: (amount * BigInt(Math.ceil(bps * 2)) + 9_999n) / 10_000n + 1n };
}

/** approve (se preciso) + depositForBurn com destino = conta de token na Solana. */
export async function burnOnSepolia(privateKey: Hex, amount: bigint, mintRecipient: PublicKey, maxFee: bigint) {
  const { account, pub, wallet } = sepoliaClients(privateKey);
  let approveHash: Hex | undefined;
  const allowance = await pub.readContract({
    address: CCTP.sepolia.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, CCTP.sepolia.tokenMessenger],
  });
  if (allowance < amount) {
    // Autoriza de uma vez um teto alto (carteira de demo, USDC de teste): as próximas transferências
    // pulam o approve e levam uma transação a menos no Ethereum.
    approveHash = await wallet.writeContract({
      address: CCTP.sepolia.usdc,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CCTP.sepolia.tokenMessenger, amount > APPROVE_CAP ? amount : APPROVE_CAP],
    });
    const r = await pub.waitForTransactionReceipt({ hash: approveHash });
    if (r.status !== "success") throw new Error(`USDC approve failed on Sepolia (${approveHash})`);
  }
  const burnHash = await wallet.writeContract({
    address: CCTP.sepolia.tokenMessenger,
    abi: TOKEN_MESSENGER_ABI,
    functionName: "depositForBurn",
    args: [
      amount,
      CCTP.solana.domain,
      toHex(mintRecipient.toBytes()),
      CCTP.sepolia.usdc,
      toHex(new Uint8Array(32)), // qualquer um pode entregar a mensagem na Solana
      maxFee,
      CCTP.fastFinality,
    ],
  });
  const r = await pub.waitForTransactionReceipt({ hash: burnHash });
  if (r.status !== "success") throw new Error(`depositForBurn failed on Sepolia (${burnHash})`);
  return { approveHash, burnHash };
}

// ------------------------------------------------------------------ Circle attestation

export type Attested = { message: Hex; attestation: Hex };

export async function waitForAttestation(burnHash: string, onPoll?: (status: string) => void, timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${CCTP.iris}/v2/messages/${CCTP.sepolia.domain}?transactionHash=${burnHash}`);
      if (res.ok) {
        const body = (await res.json()) as { messages?: { status: string; message: Hex; attestation: Hex | "PENDING" }[] };
        const m = body.messages?.[0];
        onPoll?.(m?.status ?? "not indexed yet");
        if (m && m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
          return { message: m.message, attestation: m.attestation as Hex } as Attested;
        }
      } else {
        onPoll?.(res.status === 404 ? "not indexed yet" : `HTTP ${res.status}`);
      }
    } catch {
      onPoll?.("retrying");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for Circle's attestation");
}

// ------------------------------------------------------------------ Solana devnet

/** Conta de token USDC (Circle devnet) de um dono; é o mintRecipient do burn. */
export const usdcTokenAccount = (owner: PublicKey) => ata(owner, CCTP.solana.usdcMint);

export function createUsdcAccountIx(payer: PublicKey, owner: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: usdcTokenAccount(owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: CCTP.solana.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** receiveMessage no MessageTransmitterV2, com as 11 contas do TokenMessengerMinterV2. */
export async function receiveMessageIx(conn: Connection, payer: PublicKey, att: Attested, userTokenAccount: PublicKey) {
  const { messageTransmitter: mt, tokenMessengerMinter: tmm, usdcMint } = CCTP.solana;
  const message = hexBytes(att.message);
  const attestation = hexBytes(att.attestation);
  const nonce = message.subarray(12, 44);
  const remoteDomain = String(CCTP.sepolia.domain);
  const remoteToken = new PublicKey(concat(new Uint8Array(12), hexBytes(CCTP.sepolia.usdc)));

  const tokenMessenger = pda(tmm, "token_messenger");
  const info = await conn.getAccountInfo(tokenMessenger, "confirmed");
  if (!info) throw new Error("CCTP TokenMessenger account not found on this cluster");
  const feeRecipient = new PublicKey(info.data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));

  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: mt,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, // payer (aluguel do used_nonce)
      { pubkey: payer, isSigner: true, isWritable: false }, // caller
      ro(pda(mt, "message_transmitter_authority", tmm)),
      ro(pda(mt, "message_transmitter")),
      rw(pda(mt, "used_nonce", nonce)),
      ro(tmm), // receiver
      ro(SystemProgram.programId),
      // #[event_cpi] do MessageTransmitterV2
      ro(pda(mt, "__event_authority")),
      ro(mt),
      // remaining accounts (repassadas ao TokenMessengerMinterV2)
      ro(tokenMessenger),
      ro(pda(tmm, "remote_token_messenger", remoteDomain)),
      rw(pda(tmm, "token_minter")),
      rw(pda(tmm, "local_token", usdcMint)),
      ro(pda(tmm, "token_pair", remoteDomain, remoteToken)),
      rw(ata(feeRecipient, usdcMint)),
      rw(userTokenAccount),
      rw(pda(tmm, "custody", usdcMint)),
      ro(TOKEN_PROGRAM_ID),
      ro(pda(tmm, "__event_authority")),
      ro(tmm),
    ],
    data: Buffer.from(concat(RECEIVE_MESSAGE_DISC, u32le(message.length), message, u32le(attestation.length), attestation)),
  });
}
