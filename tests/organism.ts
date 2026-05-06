import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

// ---------------------------------------------------------------------------
// Constants — mirror organism-math lib
// ---------------------------------------------------------------------------

const PRICE_SCALE = 1_000_000;
const UNIT = 1_000_000;
const PEG = PRICE_SCALE;
const NUM_RUNGS = 8;

function price(dollars: number): BN {
  return new BN(Math.round(dollars * PRICE_SCALE));
}

// Default params matching Params::default() in organism-math
const DEFAULT_PARAMS = {
  delta: new BN(5_000),
  alpha: 3,
  lambda: new BN(50_000),
  f0: new BN(3_000),
  tauWait: new BN(10),
  tauCool: new BN(30),
  tauObs: new BN(20),
  eta: new BN(100_000),
  gamma: new BN(50_000),
  iMin: new BN(100_000),
  theta: [
    new BN(50_000),
    new BN(100_000),
    new BN(200_000),
    new BN(300_000),
    new BN(450_000),
    new BN(600_000),
    new BN(750_000),
    new BN(900_000),
  ],
  thetaLow: new BN(200_000),
  thetaHigh: new BN(600_000),
};

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function findPda(seed: string, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("organism brain — on-chain experiments", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .organismBrain as Program<OrganismBrain>;
  const programId = program.programId;

  const [paramsPda] = findPda("params", programId);
  const [severityPda] = findPda("severity", programId);
  const [ladderPda] = findPda("ladder", programId);
  const [intensityPda] = findPda("intensity", programId);

  // Helper: call evaluate_transaction
  async function heartbeat(
    currentPrice: BN,
    directionHint: number,
    currentSlot: BN
  ) {
    await program.methods
      .evaluateTransaction(currentPrice, directionHint, currentSlot)
      .accounts({
        severity: severityPda,
        ladder: ladderPda,
        intensity: intensityPda,
        params: paramsPda,
      })
      .rpc();
  }

  // Helper: read state
  async function readState() {
    const [severity, ladder, intensity] = await Promise.all([
      program.account.severityState.fetch(severityPda),
      program.account.ladderState.fetch(ladderPda),
      program.account.intensityState.fetch(intensityPda),
    ]);
    return { severity, ladder, intensity };
  }

  // =========================================================================
  // Birth: initialize params + brain
  // =========================================================================

  it("initializes parameters (B5)", async () => {
    await program.methods
      .initializeParams(
        DEFAULT_PARAMS.delta,
        DEFAULT_PARAMS.alpha,
        DEFAULT_PARAMS.lambda,
        DEFAULT_PARAMS.f0,
        DEFAULT_PARAMS.tauWait,
        DEFAULT_PARAMS.tauCool,
        DEFAULT_PARAMS.tauObs,
        DEFAULT_PARAMS.eta,
        DEFAULT_PARAMS.gamma,
        DEFAULT_PARAMS.iMin,
        DEFAULT_PARAMS.theta,
        DEFAULT_PARAMS.thetaLow,
        DEFAULT_PARAMS.thetaHigh
      )
      .accounts({
        params: paramsPda,
      })
      .rpc();

    const params = await program.account.parameterAccount.fetch(paramsPda);
    expect(params.delta.toNumber()).to.equal(5_000);
    expect(params.alpha).to.equal(3);
    expect(params.tauCool.toNumber()).to.be.greaterThan(
      params.tauWait.toNumber()
    );
  });

  it("initializes brain state (B1-B3) — dormant genesis", async () => {
    await program.methods
      .initializeBrain()
      .accounts({
        severity: severityPda,
        ladder: ladderPda,
        intensity: intensityPda,
      })
      .rpc();

    const state = await readState();
    expect(state.severity.s.toNumber()).to.equal(0);
    expect(state.ladder.rung).to.equal(0);
    expect(state.ladder.tau.toNumber()).to.equal(0);
    for (let i = 0; i < NUM_RUNGS; i++) {
      expect(state.intensity.values[i].toNumber()).to.equal(0);
    }
  });

  // =========================================================================
  // Experiment 1: Severity at peg — should be zero
  // =========================================================================

  it("exp1: severity = 0 at peg", async () => {
    await heartbeat(price(1.0), 0, new BN(1));
    const state = await readState();
    expect(state.severity.s.toNumber()).to.equal(0);
    expect(state.ladder.rung).to.equal(0);
  });

  // =========================================================================
  // Experiment 2: Severity half-activation at delta
  // =========================================================================

  it("exp2: severity = 0.5 at error = delta", async () => {
    // error = 0.005 → price = 0.995
    await heartbeat(price(0.995), 1, new BN(2));
    const state = await readState();
    const s = state.severity.s.toNumber();
    // Should be ~500_000 (0.5 in UNIT scale)
    expect(s).to.be.closeTo(500_000, 1_000);
  });

  // =========================================================================
  // Experiment 3: Ladder climb under sustained pressure
  // Feed decreasing prices for enough slots to climb rungs.
  // =========================================================================

  it("exp3: ladder climbs under sustained pressure", async () => {
    // Send 80 heartbeats with price dropping from 0.99 to 0.90
    for (let slot = 3; slot < 83; slot++) {
      const t = Math.min((slot - 3) / 80.0, 1.0);
      const p = price(0.99 - 0.09 * t);
      await heartbeat(p, 1, new BN(slot));
    }

    const state = await readState();
    // Should have climbed multiple rungs
    expect(state.ladder.rung).to.be.greaterThan(0);
    console.log(
      `    ladder reached rung ${state.ladder.rung} after 80 slots of pressure`
    );
  });

  // =========================================================================
  // Experiment 4: Ladder descent after recovery
  // Return price to peg and wait for cooldown.
  // =========================================================================

  it("exp4: ladder descends after recovery", async () => {
    const stateBefore = await readState();
    const rungBefore = stateBefore.ladder.rung;

    // Send heartbeats at peg for enough slots to allow descent
    // tau_cool = 30, so we need > 30 slots per rung descent
    for (let slot = 83; slot < 283; slot++) {
      await heartbeat(price(1.0), -1, new BN(slot));
    }

    const stateAfter = await readState();
    expect(stateAfter.ladder.rung).to.be.lessThan(rungBefore);
    console.log(
      `    ladder descended from rung ${rungBefore} to rung ${stateAfter.ladder.rung}`
    );
  });

  // =========================================================================
  // Experiment 5: Hysteresis — oscillation does not cause rung flapping
  // =========================================================================

  it("exp5: hysteresis resists oscillation", async () => {
    // Track rung changes per tick — hysteresis means no rapid flapping
    let flaps = 0; // a flap = rung goes up then down (or vice versa) within 2 ticks
    let prevRung = (await readState()).ladder.rung;
    let prevDir = 0; // +1 = climbed, -1 = descended, 0 = held

    for (let slot = 283; slot < 383; slot++) {
      const p = slot % 2 === 0 ? price(0.995) : price(1.005);
      await heartbeat(p, 0, new BN(slot));
      const state = await readState();
      const curRung = state.ladder.rung;
      const dir = curRung > prevRung ? 1 : curRung < prevRung ? -1 : 0;
      if (dir !== 0 && prevDir !== 0 && dir !== prevDir) {
        flaps++;
      }
      if (dir !== 0) prevDir = dir;
      prevRung = curRung;
    }

    // Hysteresis: should have zero direction reversals (no flapping)
    expect(flaps).to.equal(0);
    console.log(
      `    direction reversals (flaps) = ${flaps} across 100 oscillations`
    );
  });
});
