#!/usr/bin/env ts-node
/**
 * Interactive Nyxanic terminal — direct human interaction with the Organism.
 *
 *   buy  : swap NTT → NYX
 *   sell : swap NYX → NTT
 *   air  : airdrop NTT (50k max, 8h cooldown)
 *   hb   : heartbeat (refresh brain directive)
 *   r    : refresh dashboard
 *   q    : quit
 *
 * Run via: anchor run terminal
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { NyxanicTestToken } from "../target/types/nyxanic_test_token";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICE_SCALE = 1_000_000;
const UNIT = 1_000_000;
const AIRDROP_MAX_PER_CALL = 50_000_000_000;
const AIRDROP_COOLDOWN_SECS = 8 * 60 * 60;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function fmt(base: number, decimals = 6, places = 4): string {
  return (base / Math.pow(10, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

function fmtPct(ppm: number): string {
  return (ppm / 10_000).toFixed(4) + "%";
}

function modeColor(mode: string): string {
  return ({
    execute: C.green,
    throttle: C.yellow,
    route: C.magenta,
    halt: C.red,
  } as Record<string, string>)[mode] || C.white;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e);
      if ((msg.includes("Blockhash not found") || msg.includes("block height exceeded")) && i < attempts) {
        await sleep(1500);
        continue;
      }
      lastErr = e;
      throw e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const conn = provider.connection;
const wallet = provider.wallet as anchor.Wallet;

const ntt = anchor.workspace.nyxanicTestToken as Program<NyxanicTestToken>;
const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
const body = anchor.workspace.organismToken as Program<OrganismToken>;

// PDAs
const nttMint = findPda([Buffer.from("ntt_mint")], ntt.programId);
const nttAuthority = findPda([Buffer.from("ntt_mint_authority")], ntt.programId);
const nttConfig = findPda([Buffer.from("ntt_config")], ntt.programId);
const myAirdropRecord = findPda(
  [Buffer.from("ntt_airdrop"), wallet.publicKey.toBuffer()],
  ntt.programId
);

const orgMint = findPda([Buffer.from("mint")], body.programId);
const mintAuthority = findPda([Buffer.from("mint_authority")], body.programId);
const bodyState = findPda([Buffer.from("body_state")], body.programId);
const lpState = findPda([Buffer.from("lp_state")], body.programId);
const collateralVault = findPda([Buffer.from("collateral_vault")], body.programId);
const feeCollector = findPda([Buffer.from("fee_collector")], body.programId);

const brainSeverity = findPda([Buffer.from("severity")], brain.programId);
const brainLadder = findPda([Buffer.from("ladder")], brain.programId);
const brainIntensity = findPda([Buffer.from("intensity")], brain.programId);
const brainActiveSet = findPda([Buffer.from("active_set")], brain.programId);
const brainParams = findPda([Buffer.from("params")], brain.programId);

let myNttAta: PublicKey;
let myOrgAta: PublicKey;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  sol: number;
  myNtt: number;
  myNyx: number;
  vault: number;
  supply: number;
  feesNyx: number;
  price: number;
  rung: number;
  mode: string;
  fee: number;
  spread: number;
  throttle: number;
  collatTarget: number;
  airdropCooldownRemaining: number;
  airdropTotalToMe: number;
  globalAirdropped: number;
  globalLiquidityMinted: number;
}

async function snapshot(): Promise<Snapshot> {
  const sol = await conn.getBalance(wallet.publicKey);
  const myNttAcc = await getAccount(conn, myNttAta).catch(() => null);
  const myOrgAcc = await getAccount(conn, myOrgAta).catch(() => null);
  const v = await getAccount(conn, collateralVault);
  const m = await getMint(conn, orgMint);
  const fc = await getAccount(conn, feeCollector);
  const bs = await body.account.bodyState.fetch(bodyState);
  const ls = await brain.account.ladderState.fetch(brainLadder);

  const cfg = await ntt.account.tokenConfig.fetch(nttConfig).catch(() => null);
  const myRec = await ntt.account.airdropRecord.fetch(myAirdropRecord).catch(() => null);

  const now = Math.floor(Date.now() / 1000);
  const cooldown = myRec
    ? Math.max(0, AIRDROP_COOLDOWN_SECS - (now - myRec.lastAirdropUnix.toNumber()))
    : 0;

  const supply = Number(m.supply);
  const vault = Number(v.amount);
  const dir = bs.currentDirective;
  return {
    sol,
    myNtt: myNttAcc ? Number(myNttAcc.amount) : 0,
    myNyx: myOrgAcc ? Number(myOrgAcc.amount) : 0,
    vault,
    supply,
    feesNyx: Number(fc.amount),
    price: supply > 0 ? vault / supply : 1,
    rung: ls.rung,
    mode: Object.keys(dir.executionMode)[0],
    fee: dir.feeAdjustment.toNumber(),
    spread: dir.spreadAdjustment.toNumber(),
    throttle: dir.throttleFactor,
    collatTarget: dir.collateralRatioTarget,
    airdropCooldownRemaining: cooldown,
    airdropTotalToMe: myRec ? myRec.totalAirdroppedToWallet.toNumber() : 0,
    globalAirdropped: cfg ? cfg.airdropped.toNumber() : 0,
    globalLiquidityMinted: cfg ? cfg.liquidityMinted.toNumber() : 0,
  };
}

function render(s: Snapshot, lastMsg: string) {
  process.stdout.write("\x1b[2J\x1b[H");
  const W = 72;
  const bar = "═".repeat(W);
  const dash = "─".repeat(W);

  console.log(C.cyan + bar + C.reset);
  console.log(C.bold + "   N Y X A N I C   —   t e r m i n a l" + C.reset);
  console.log(C.cyan + bar + C.reset);

  // Organism state
  const priceColor =
    Math.abs(s.price - 1) < 0.001 ? C.green : (s.price > 1 ? C.yellow : C.red);
  console.log(`  ${C.bold}NYX (organism)${C.reset}`);
  console.log(`    supply           : ${fmt(s.supply).padStart(20)}  NYX`);
  console.log(`    backed by vault  : ${fmt(s.vault).padStart(20)}  NTT`);
  console.log(`    price            : ${priceColor}${s.price.toFixed(6).padStart(20)}${C.reset}    (peg = 1.000000)`);
  console.log(`    fees collected   : ${fmt(s.feesNyx).padStart(20)}  NYX`);
  console.log("");

  // Brain
  const rungColor = s.rung === 0 ? C.green : (s.rung < 5 ? C.yellow : C.red);
  console.log(`  ${C.bold}brain${C.reset}`);
  console.log(`    rung             : ${rungColor}${s.rung}${C.reset}`);
  console.log(`    mode             : ${modeColor(s.mode)}${s.mode.toUpperCase()}${C.reset}`);
  console.log(`    fee adj          : ${fmtPct(s.fee)}`);
  console.log(`    spread           : ${fmtPct(s.spread)}`);
  // throttle: 10000 = full capacity (no restriction). Display the *reduction*
  // so the number rises with stress (0% = open, 100% = fully throttled).
  const throttleReduction = 100 - s.throttle / 100;
  const throttleStr = throttleReduction <= 0
    ? `${C.green}OFF${C.reset}`
    : `${C.yellow}${throttleReduction.toFixed(2)}% restriction${C.reset}`;
  console.log(`    throttle         : ${throttleStr}`);
  if (s.collatTarget > 0) {
    console.log(`    collat target    : ${(s.collatTarget / UNIT).toFixed(4)}`);
  }
  console.log("");

  // My wallet
  console.log(`  ${C.bold}your wallet${C.reset}  ${C.dim}${wallet.publicKey.toBase58()}${C.reset}`);
  console.log(`    SOL              : ${(s.sol / LAMPORTS_PER_SOL).toFixed(6)}`);
  console.log(`    NTT (collateral) : ${fmt(s.myNtt).padStart(20)}`);
  console.log(`    NYX              : ${fmt(s.myNyx).padStart(20)}`);
  console.log("");

  // Airdrop status
  console.log(`  ${C.bold}airdrop status${C.reset}`);
  if (s.airdropCooldownRemaining > 0) {
    const h = Math.floor(s.airdropCooldownRemaining / 3600);
    const m = Math.floor((s.airdropCooldownRemaining % 3600) / 60);
    console.log(`    cooldown         : ${C.red}${h}h ${m}m remaining${C.reset}`);
  } else {
    console.log(`    cooldown         : ${C.green}READY${C.reset}`);
  }
  console.log(`    total received   : ${fmt(s.airdropTotalToMe).padStart(20)}  NTT`);
  console.log(`    max per call     : ${fmt(AIRDROP_MAX_PER_CALL).padStart(20)}  NTT`);
  console.log("");

  // Global supply
  console.log(`  ${C.bold}NTT global${C.reset}`);
  console.log(`    airdropped       : ${fmt(s.globalAirdropped).padStart(20)}  / 100,000,000`);
  console.log(`    liquidity minted : ${fmt(s.globalLiquidityMinted).padStart(20)}  / 900,000,000`);
  console.log("");

  // Last message
  if (lastMsg) {
    console.log(`  ${lastMsg}`);
    console.log("");
  }

  console.log(C.cyan + bar + C.reset);
  console.log(`  ${C.bold}commands${C.reset}: ` +
    `${C.green}[b]uy${C.reset} NYX  ` +
    `${C.blue}[s]ell${C.reset} NYX  ` +
    `${C.cyan}[a]irdrop${C.reset} NTT  ` +
    `${C.magenta}[h]eartbeat${C.reset}  ` +
    `${C.dim}[r]efresh${C.reset}  ` +
    `${C.dim}[q]uit${C.reset}`);
  console.log(C.cyan + bar + C.reset);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Compute ATA addresses synchronously (no network call). The accounts get
/// created on-demand by piggybacking the create-ATA instruction onto the
/// first action that needs them.
function computeAtas(): void {
  myNttAta = PublicKey.findProgramAddressSync(
    [
      wallet.publicKey.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      nttMint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  )[0];
  myOrgAta = PublicKey.findProgramAddressSync(
    [
      wallet.publicKey.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      orgMint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  )[0];
}

/// Idempotent create-ATA instructions — bundled with actions that need the ATAs.
function ensureAtaIxs(): anchor.web3.TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, myNttAta, wallet.publicKey, nttMint),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, myOrgAta, wallet.publicKey, orgMint),
  ];
}

async function doAirdrop(amountStr: string): Promise<string> {
  const amt = Math.floor(parseFloat(amountStr) * 1_000_000);
  if (!amt || amt <= 0) return `${C.red}invalid amount${C.reset}`;
  if (amt > AIRDROP_MAX_PER_CALL) return `${C.red}max per call is 50,000 NTT${C.reset}`;

  await withRetry("airdrop", () =>
    ntt.methods
      .airdrop(new BN(amt))
      .accounts({
        mint: nttMint,
        mintAuthority: nttAuthority,
        config: nttConfig,
        recipient: myNttAta,
        recipientWallet: wallet.publicKey,
        airdropRecord: myAirdropRecord,
        payer: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(ensureAtaIxs())
      .rpc({ commitment: "confirmed" })
  );
  return `${C.green}✓ airdropped ${(amt / 1e6).toFixed(2)} NTT${C.reset}`;
}

async function doHeartbeat(): Promise<string> {
  await withRetry("hb", () =>
    body.methods
      .heartbeatObserved(new BN(Date.now() % 1_000_000))
      .accounts({
        mint: orgMint,
        collateralVault,
        bodyState,
        brainSeverity,
        brainLadder,
        brainIntensity,
        brainActiveSet,
        brainParams,
        brainProgram: brain.programId,
      })
      .rpc({ commitment: "confirmed" })
  );
  return `${C.green}✓ heartbeat — directive refreshed${C.reset}`;
}

async function doBuy(amountStr: string): Promise<string> {
  const amt = Math.floor(parseFloat(amountStr) * 1_000_000);
  if (!amt || amt <= 0) return `${C.red}invalid amount${C.reset}`;

  await withRetry("buy", () =>
    body.methods
      .lpSwapIn(new BN(amt))
      .accounts({
        mint: orgMint,
        mintAuthority,
        bodyState,
        lpState,
        collateralVault,
        userCollateral: myNttAta,
        userOrg: myOrgAta,
        feeCollector,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(ensureAtaIxs())
      .rpc({ commitment: "confirmed" })
  );
  return `${C.green}✓ bought NYX with ${(amt / 1e6).toFixed(2)} NTT${C.reset}`;
}

async function doSell(amountStr: string): Promise<string> {
  const amt = Math.floor(parseFloat(amountStr) * 1_000_000);
  if (!amt || amt <= 0) return `${C.red}invalid amount${C.reset}`;

  await withRetry("sell", () =>
    body.methods
      .lpSwapOut(new BN(amt))
      .accounts({
        mint: orgMint,
        mintAuthority,
        bodyState,
        lpState,
        collateralVault,
        userCollateral: myNttAta,
        userOrg: myOrgAta,
        user: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(ensureAtaIxs())
      .rpc({ commitment: "confirmed" })
  );
  return `${C.green}✓ sold ${(amt / 1e6).toFixed(2)} NYX${C.reset}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  computeAtas();

  let lastMsg = `${C.dim}welcome — type a command below${C.reset}`;

  while (true) {
    let snap: Snapshot;
    try {
      snap = await snapshot();
    } catch (e: any) {
      console.log(`${C.red}snapshot failed: ${String(e).split("\n")[0]}${C.reset}`);
      await sleep(1500);
      continue;
    }

    render(snap, lastMsg);

    const cmd = (await ask("> ")).trim().toLowerCase();

    try {
      switch (cmd) {
        case "q":
        case "quit":
        case "exit":
          rl.close();
          process.stdout.write(`\n${C.dim}exit${C.reset}\n`);
          process.exit(0);

        case "r":
        case "refresh":
          lastMsg = `${C.dim}refreshed${C.reset}`;
          break;

        case "h":
        case "hb":
        case "heartbeat":
          lastMsg = await doHeartbeat();
          break;

        case "a":
        case "air":
        case "airdrop": {
          if (snap.airdropCooldownRemaining > 0) {
            const h = Math.floor(snap.airdropCooldownRemaining / 3600);
            const m = Math.floor((snap.airdropCooldownRemaining % 3600) / 60);
            lastMsg = `${C.red}cooldown ${h}h ${m}m remaining${C.reset}`;
            break;
          }
          const amt = await ask(`amount NTT (max ${AIRDROP_MAX_PER_CALL / 1e6}): `);
          lastMsg = await doAirdrop(amt);
          break;
        }

        case "b":
        case "buy": {
          const amt = await ask(`NTT to spend: `);
          lastMsg = await doBuy(amt);
          break;
        }

        case "s":
        case "sell": {
          const amt = await ask(`NYX to sell: `);
          lastMsg = await doSell(amt);
          break;
        }

        default:
          lastMsg = `${C.dim}unknown command "${cmd}"${C.reset}`;
      }
    } catch (e: any) {
      const msg = String(e).split("\n")[0];
      // Anchor errors include the human-readable name in the chain
      const errMatch =
        msg.match(/Error Code: (\w+)/) ||
        msg.match(/(Halted|Throttled|InsufficientCollateralRatio|AirdropOnCooldown|InvalidAmount|AirdropQuotaExhausted|LiquidityQuotaExhausted)/);
      const errName = errMatch ? errMatch[1] : msg.slice(0, 80);
      lastMsg = `${C.red}✗ ${errName}${C.reset}`;
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
