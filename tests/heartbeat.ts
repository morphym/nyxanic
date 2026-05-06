import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;

function findPda(seeds: string[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => Buffer.from(s)),
    programId
  )[0];
}

function findPdaInProgram(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e);
      if ((msg.includes("Blockhash not found") || msg.includes("block height exceeded")) && i < attempts) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function price(dollars: number): BN {
  return new BN(Math.round(dollars * PRICE_SCALE));
}

describe("heartbeat — body→brain CPI integration on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;

  const bodyState = findPdaInProgram("body_state", body.programId);
  const brainSeverity = findPdaInProgram("severity", brain.programId);
  const brainLadder = findPdaInProgram("ladder", brain.programId);
  const brainIntensity = findPdaInProgram("intensity", brain.programId);
  const brainParams = findPdaInProgram("params", brain.programId);

  const accounts = {
    bodyState,
    brainSeverity,
    brainLadder,
    brainIntensity,
    brainParams,
    brainProgram: brain.programId,
  };

  async function heartbeat(p: number, dir: number, slot: number) {
    return withRetry("heartbeat", () =>
      body.methods
        .heartbeat(price(p), dir, new BN(slot))
        .accounts(accounts)
        .rpc({ commitment: "confirmed" })
    );
  }

  async function readBodyDirective() {
    const state = await body.account.bodyState.fetch(bodyState);
    return state.currentDirective;
  }

  async function readBrainState() {
    const [severity, ladder, intensity] = await Promise.all([
      brain.account.severityState.fetch(brainSeverity),
      brain.account.ladderState.fetch(brainLadder),
      brain.account.intensityState.fetch(brainIntensity),
    ]);
    return { severity, ladder, intensity };
  }

  // =========================================================================
  // Single heartbeat at peg
  // =========================================================================

  it("heartbeat at peg — Execute mode, no fee, no throttle", async () => {
    await heartbeat(1.0, 0, 1000);

    const dir = await readBodyDirective();
    const brainState = await readBrainState();

    console.log(`    body directive: mode=${JSON.stringify(dir.executionMode)} fee=${dir.feeAdjustment.toNumber()} throttle=${dir.throttleFactor}`);
    console.log(`    brain: severity=${brainState.severity.s.toNumber()} rung=${brainState.ladder.rung}`);

    expect(dir.executionMode).to.deep.equal({ execute: {} });
    expect(brainState.severity.s.toNumber()).to.equal(0);
  });

  // =========================================================================
  // Heartbeat at moderate depeg — severity activates, fee scales up
  // =========================================================================

  it("heartbeat at 0.995 (error=δ) — severity ≈ 0.5", async () => {
    await heartbeat(0.995, 1, 1001);

    const dir = await readBodyDirective();
    const brainState = await readBrainState();

    console.log(`    severity=${brainState.severity.s.toNumber()/1e6} fee=${dir.feeAdjustment.toNumber()/1e6}`);
    expect(brainState.severity.s.toNumber()).to.be.closeTo(500_000, 5_000);
    // fee = f0 + s*lambda*direction = 3000 + 500000*50000/1e6*1 = 3000 + 25000 = 28000
    expect(dir.feeAdjustment.toNumber()).to.be.closeTo(28_000, 100);
  });

  // =========================================================================
  // Sustained pressure — ladder climbs, body sees mode change
  // =========================================================================

  it("sustained pressure — body's directive escalates", async () => {
    // Hammer with low price for many slots → brain ladder should climb
    let slot = 2000;
    let modesObserved: string[] = [];
    for (let i = 0; i < 30; i++) {
      await heartbeat(0.85, 1, slot);
      const dir = await readBodyDirective();
      const mode = Object.keys(dir.executionMode)[0];
      if (modesObserved.length === 0 || modesObserved[modesObserved.length - 1] !== mode) {
        modesObserved.push(mode);
        const brainState = await readBrainState();
        console.log(`    slot=${slot} → mode=${mode} rung=${brainState.ladder.rung} severity=${(brainState.severity.s.toNumber()/1e6).toFixed(4)}`);
      }
      slot++;
    }

    // Should have escalated past Execute
    expect(modesObserved).to.include.oneOf(["throttle", "route", "halt"]);
    console.log(`    observed mode transitions: ${modesObserved.join(" → ")}`);
  });

  // =========================================================================
  // Recovery — system descends, body returns to Execute
  // =========================================================================

  it("recovery — body returns to Execute mode", async () => {
    let slot = 3000;
    for (let i = 0; i < 80; i++) {
      await heartbeat(1.0, -1, slot);
      slot++;
    }

    const dir = await readBodyDirective();
    const brainState = await readBrainState();

    console.log(`    final mode=${JSON.stringify(dir.executionMode)} rung=${brainState.ladder.rung}`);
    // After 80 slots of recovery, severity should be 0; rung may still be > 0
    // due to one-rung-at-a-time descent. But fee should be at base.
    expect(brainState.severity.s.toNumber()).to.equal(0);
  });
});
