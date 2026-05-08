import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { NyxanicTestToken } from "../target/types/nyxanic_test_token";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;
const UNIT = 1_000_000;
const N_ACCOUNTS = 7;
const AIRDROP_PER_ACC = 600_000_000;     // 600 NTT (6 decimals)
const SOL_FUND_PER_ACC = 10_000_000;     // 0.01 SOL
const MAX_ITER = 80;

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
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
// TUI helpers
// ---------------------------------------------------------------------------

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function fmt(n: number, decimals = 6): string {
  return (n / Math.pow(10, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function fmtPct(n: number): string {
  // n is in PPM (parts per million)
  return (n / 10_000).toFixed(4) + "%";
}

function modeColor(mode: string): string {
  switch (mode) {
    case "execute":  return COLOR.green;
    case "throttle": return COLOR.yellow;
    case "route":    return COLOR.magenta;
    case "halt":     return COLOR.red;
    default:         return "";
  }
}

interface DashboardState {
  iter: number;
  totalIter: number;
  supply: number;
  vault: number;
  feesNtt: number;
  feesOrg: number;
  price: number;
  mode: string;
  rung: number;
  fee: number;
  spread: number;
  throttle: number;
  collatTarget: number;
  walletBalances: { ntt: number; org: number }[];
  log: string[];
  status: string;
}

function render(s: DashboardState) {
  clearScreen();
  const W = 72;
  const bar = "═".repeat(W);
  const dash = "─".repeat(W);

  console.log(COLOR.cyan + bar + COLOR.reset);
  const title = `   N Y X A N I C   —   r a n d o m   t r a d e`;
  const iterStr = `  iter ${s.iter}/${s.totalIter}`;
  console.log(COLOR.bold + title + COLOR.reset + " ".repeat(W - title.length - iterStr.length) + iterStr);
  console.log(COLOR.cyan + bar + COLOR.reset);

  const pegged = Math.abs(s.price - 1) < 0.001;
  const priceColor = pegged ? COLOR.green : (s.price > 1 ? COLOR.yellow : COLOR.red);

  console.log(`  ${COLOR.bold}NYX supply:${COLOR.reset}            ${fmt(s.supply).padStart(20)}  NYX`);
  console.log(`  ${COLOR.bold}NTT vault (collateral):${COLOR.reset}${fmt(s.vault).padStart(12)}  NTT`);
  console.log(`  ${COLOR.dim}${dash}${COLOR.reset}`);
  console.log(`  ${COLOR.bold}NYX price:${COLOR.reset}             ${priceColor}${(s.price).toFixed(6).padStart(20)}${COLOR.reset}    (peg = 1.0)`);
  console.log(`  ${COLOR.bold}fees collected (NTT):${COLOR.reset} ${fmt(s.feesNtt).padStart(14)}`);
  console.log(`  ${COLOR.bold}fees collected (NYX):${COLOR.reset} ${fmt(s.feesOrg).padStart(14)}`);
  console.log("");

  // Brain block
  console.log(`  ${COLOR.bold}brain rung:${COLOR.reset}  ${s.rung}`);
  console.log(`  ${COLOR.bold}mode:${COLOR.reset}        ${modeColor(s.mode)}${s.mode.toUpperCase()}${COLOR.reset}`);
  console.log(`  ${COLOR.dim}fee adj:${COLOR.reset}     ${fmtPct(s.fee)}`);
  console.log(`  ${COLOR.dim}spread:${COLOR.reset}      ${fmtPct(s.spread)}`);
  console.log(`  ${COLOR.dim}throttle:${COLOR.reset}    ${(s.throttle / 100).toFixed(2)}%`);
  if (s.collatTarget > 0) {
    console.log(`  ${COLOR.dim}collat target:${COLOR.reset} ${(s.collatTarget / UNIT).toFixed(4)}`);
  }
  console.log("");

  // Wallet balances
  console.log(`  ${COLOR.bold}wallet balances:${COLOR.reset}`);
  s.walletBalances.forEach((b, i) => {
    console.log(`    [${i + 1}]  NTT ${fmt(b.ntt).padStart(10)}    NYX ${fmt(b.org).padStart(10)}`);
  });
  console.log("");

  // Log
  console.log(`  ${COLOR.bold}recent activity:${COLOR.reset}`);
  s.log.slice(-6).forEach(l => console.log(`    ${l}`));
  console.log("");

  console.log(COLOR.cyan + bar + COLOR.reset);
  console.log(`  status: ${s.status}`);
  console.log(COLOR.cyan + bar + COLOR.reset);
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

describe("random — multi-account random trades on the Organism (TUI)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const main = provider.wallet as anchor.Wallet;

  const ntt = anchor.workspace.nyxanicTestToken as Program<NyxanicTestToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const body = anchor.workspace.organismToken as Program<OrganismToken>;

  // NTT PDAs
  const nttMint = findPda([Buffer.from("ntt_mint")], ntt.programId);
  const nttAuthority = findPda([Buffer.from("ntt_mint_authority")], ntt.programId);
  const nttConfig = findPda([Buffer.from("ntt_config")], ntt.programId);

  // Brain PDAs
  const brainSeverity = findPda([Buffer.from("severity")], brain.programId);
  const brainLadder = findPda([Buffer.from("ladder")], brain.programId);
  const brainIntensity = findPda([Buffer.from("intensity")], brain.programId);
  const brainActiveSet = findPda([Buffer.from("active_set")], brain.programId);
  const brainParams = findPda([Buffer.from("params")], brain.programId);

  // Body PDAs
  const orgMint = findPda([Buffer.from("mint")], body.programId);
  const mintAuthority = findPda([Buffer.from("mint_authority")], body.programId);
  const bodyState = findPda([Buffer.from("body_state")], body.programId);
  const lpState = findPda([Buffer.from("lp_state")], body.programId);
  const collateralVault = findPda([Buffer.from("collateral_vault")], body.programId);
  const feeCollector = findPda([Buffer.from("fee_collector")], body.programId);

  const wallets: Keypair[] = [];
  const nttAtas: PublicKey[] = [];
  const orgAtas: PublicKey[] = [];

  // -------------------------------------------------------------------------
  // PHASE 1: spawn N wallets, fund each, airdrop 600 NTT
  // -------------------------------------------------------------------------

  it("spawn 7 wallets, fund + airdrop 600 NTT each", async () => {
    for (let i = 0; i < N_ACCOUNTS; i++) {
      wallets.push(Keypair.generate());
    }

    // Fund each wallet with SOL (single batched tx)
    const fundTx = new Transaction();
    for (const w of wallets) {
      fundTx.add(SystemProgram.transfer({
        fromPubkey: main.publicKey,
        toPubkey: w.publicKey,
        lamports: SOL_FUND_PER_ACC,
      }));
    }
    await withRetry("fund", () => provider.sendAndConfirm(fundTx, []));
    console.log(`    funded ${N_ACCOUNTS} wallets with ${SOL_FUND_PER_ACC / LAMPORTS_PER_SOL} SOL each`);

    // Create ATAs (NTT + ORG) for each wallet, paid by main
    for (let i = 0; i < N_ACCOUNTS; i++) {
      const w = wallets[i];
      const nttAta = await getAssociatedTokenAddress(nttMint, w.publicKey);
      const orgAta = await getAssociatedTokenAddress(orgMint, w.publicKey);
      const tx = new Transaction()
        .add(createAssociatedTokenAccountIdempotentInstruction(main.publicKey, nttAta, w.publicKey, nttMint))
        .add(createAssociatedTokenAccountIdempotentInstruction(main.publicKey, orgAta, w.publicKey, orgMint));
      await withRetry(`atas[${i}]`, () => provider.sendAndConfirm(tx, []));
      nttAtas.push(nttAta);
      orgAtas.push(orgAta);
    }
    console.log(`    created NTT + ORG ATAs for ${N_ACCOUNTS} wallets`);

    // Airdrop 600 NTT to each, paid by main, recipient_wallet = each
    for (let i = 0; i < N_ACCOUNTS; i++) {
      const w = wallets[i];
      const airdropRecord = findPda(
        [Buffer.from("ntt_airdrop"), w.publicKey.toBuffer()],
        ntt.programId
      );
      await withRetry(`airdrop[${i}]`, () =>
        ntt.methods
          .airdrop(new BN(AIRDROP_PER_ACC))
          .accounts({
            mint: nttMint,
            mintAuthority: nttAuthority,
            config: nttConfig,
            recipient: nttAtas[i],
            recipientWallet: w.publicKey,
            airdropRecord,
            payer: main.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" })
      );
    }
    console.log(`    airdropped ${AIRDROP_PER_ACC / 1e6} NTT to each (total ${(AIRDROP_PER_ACC * N_ACCOUNTS) / 1e6} NTT)`);
  });

  // -------------------------------------------------------------------------
  // PHASE 2: random trade loop with TUI
  // -------------------------------------------------------------------------

  it("random buy/sell loop with TUI", async () => {
    // Initial balance fetch
    const balances: { ntt: number; org: number }[] = [];
    for (let i = 0; i < N_ACCOUNTS; i++) {
      const ntt = Number((await getAccount(conn, nttAtas[i])).amount);
      const org = Number((await getAccount(conn, orgAtas[i])).amount);
      balances.push({ ntt, org });
    }

    const log: string[] = [];
    const append = (s: string) => log.push(`${COLOR.dim}${new Date().toISOString().slice(11, 19)}${COLOR.reset} ${s}`);

    let stopped = false;
    let stopReason = "running...";
    let baseSlot = Date.now() % 1_000_000;

    for (let iter = 1; iter <= MAX_ITER && !stopped; iter++) {
      // Heartbeat first to refresh directive (paid by main, permissionless)
      try {
        await withRetry("hb", () =>
          body.methods
            .heartbeatObserved(new BN(baseSlot + iter))
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
      } catch (e: any) {
        append(`${COLOR.red}heartbeat failed: ${String(e).split("\n")[0]}${COLOR.reset}`);
      }

      // Read state
      const m = await getMint(conn, orgMint);
      const v = await getAccount(conn, collateralVault);
      const fcOrg = await getAccount(conn, feeCollector);
      const supply = Number(m.supply);
      const vault = Number(v.amount);
      const feesOrg = Number(fcOrg.amount);
      const price = supply > 0 ? vault / supply : 1;

      const stateAcc = await body.account.bodyState.fetch(bodyState);
      const ladderAcc = await brain.account.ladderState.fetch(brainLadder);
      const dir = stateAcc.currentDirective;
      const mode = Object.keys(dir.executionMode)[0];

      const dashState: DashboardState = {
        iter,
        totalIter: MAX_ITER,
        supply,
        vault,
        feesNtt: 0, // we don't track NTT fees separately
        feesOrg,
        price,
        mode,
        rung: ladderAcc.rung,
        fee: dir.feeAdjustment.toNumber(),
        spread: dir.spreadAdjustment.toNumber(),
        throttle: dir.throttleFactor,
        collatTarget: dir.collateralRatioTarget,
        walletBalances: balances,
        log,
        status: stopReason,
      };
      render(dashState);

      // Stop conditions
      if (mode !== "execute") {
        stopped = true;
        stopReason = `${COLOR.yellow}STOPPED — brain mode=${mode.toUpperCase()} (rung=${ladderAcc.rung})${COLOR.reset}`;
        dashState.status = stopReason;
        render(dashState);
        break;
      }

      // Pick a random wallet + action
      const idx = Math.floor(Math.random() * N_ACCOUNTS);
      const w = wallets[idx];
      const b = balances[idx];

      // Decide buy vs sell. If only NTT, must buy. If only ORG, must sell.
      let action: "in" | "out";
      if (b.ntt < 1_000_000 && b.org > 1_000_000) action = "out";
      else if (b.org < 1_000_000 && b.ntt > 1_000_000) action = "in";
      else action = Math.random() < 0.5 ? "in" : "out";

      // Random fraction of balance: 5%-40%
      const frac = 0.05 + Math.random() * 0.35;
      const sourceBal = action === "in" ? b.ntt : b.org;
      let amount = Math.floor(sourceBal * frac);
      // Round to multiples of 1k base units; minimum 1M
      amount = Math.max(1_000_000, Math.floor(amount / 1_000_000) * 1_000_000);
      if (amount > sourceBal) amount = sourceBal;

      if (amount < 1_000_000) {
        append(`${COLOR.dim}wallet[${idx + 1}] no balance; skip${COLOR.reset}`);
        await sleep(150);
        continue;
      }

      // Execute swap
      try {
        if (action === "in") {
          await withRetry(`swap_in[${iter}]`, () =>
            body.methods
              .lpSwapIn(new BN(amount))
              .accounts({
                mint: orgMint,
                mintAuthority,
                bodyState,
                lpState,
                collateralVault,
                userCollateral: nttAtas[idx],
                userOrg: orgAtas[idx],
                feeCollector,
                user: w.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([w])
              .rpc({ commitment: "confirmed" })
          );
          // Refresh this wallet's balances
          balances[idx] = {
            ntt: Number((await getAccount(conn, nttAtas[idx])).amount),
            org: Number((await getAccount(conn, orgAtas[idx])).amount),
          };
          append(`${COLOR.green}w[${idx + 1}] ${COLOR.bold}BUY ${COLOR.reset}${COLOR.green}${(amount / 1e6).toFixed(2)} NTT → NYX${COLOR.reset}`);
        } else {
          await withRetry(`swap_out[${iter}]`, () =>
            body.methods
              .lpSwapOut(new BN(amount))
              .accounts({
                mint: orgMint,
                mintAuthority,
                bodyState,
                lpState,
                collateralVault,
                userCollateral: nttAtas[idx],
                userOrg: orgAtas[idx],
                user: w.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([w])
              .rpc({ commitment: "confirmed" })
          );
          balances[idx] = {
            ntt: Number((await getAccount(conn, nttAtas[idx])).amount),
            org: Number((await getAccount(conn, orgAtas[idx])).amount),
          };
          append(`${COLOR.blue}w[${idx + 1}] ${COLOR.bold}SELL ${COLOR.reset}${COLOR.blue}${(amount / 1e6).toFixed(2)} NYX → NTT${COLOR.reset}`);
        }
      } catch (e: any) {
        const msg = String(e);
        if (msg.includes("Halted")) {
          stopped = true;
          stopReason = `${COLOR.red}STOPPED — swap rejected: HALTED${COLOR.reset}`;
        } else if (msg.includes("Throttled")) {
          stopped = true;
          stopReason = `${COLOR.yellow}STOPPED — swap rejected: THROTTLED${COLOR.reset}`;
        } else if (msg.includes("InsufficientCollateralRatio")) {
          stopped = true;
          stopReason = `${COLOR.magenta}STOPPED — swap rejected: ℓ7 collateral ratio${COLOR.reset}`;
        } else {
          append(`${COLOR.red}w[${idx + 1}] err: ${msg.split("\n")[0].slice(0, 60)}${COLOR.reset}`);
        }
      }

      await sleep(120);
    }

    // Final render
    if (!stopped) stopReason = `${COLOR.green}COMPLETED — ${MAX_ITER} iterations, peg held${COLOR.reset}`;
    const m = await getMint(conn, orgMint);
    const v = await getAccount(conn, collateralVault);
    const fcOrg = await getAccount(conn, feeCollector);
    const stateAcc = await body.account.bodyState.fetch(bodyState);
    const ladderAcc = await brain.account.ladderState.fetch(brainLadder);
    const dir = stateAcc.currentDirective;
    render({
      iter: MAX_ITER,
      totalIter: MAX_ITER,
      supply: Number(m.supply),
      vault: Number(v.amount),
      feesNtt: 0,
      feesOrg: Number(fcOrg.amount),
      price: Number(v.amount) / Number(m.supply),
      mode: Object.keys(dir.executionMode)[0],
      rung: ladderAcc.rung,
      fee: dir.feeAdjustment.toNumber(),
      spread: dir.spreadAdjustment.toNumber(),
      throttle: dir.throttleFactor,
      collatTarget: dir.collateralRatioTarget,
      walletBalances: balances,
      log,
      status: stopReason,
    });

    // Pause briefly so the final TUI is visible before mocha cleans up
    await sleep(3000);
  });
});
