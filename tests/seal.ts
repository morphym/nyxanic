import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

function price(d: number): BN {
  return new BN(Math.round(d * PRICE_SCALE));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e);
      if ((msg.includes("Blockhash not found") || msg.includes("block height exceeded")) && i < attempts) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      lastErr = e;
      throw e;
    }
  }
  throw lastErr;
}

describe("§6 step 9 — authority handoff (seal_body) on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const wallet = provider.wallet as anchor.Wallet;

  const bodyState = findPda("body_state", body.programId);
  const poolRegistry = findPda("pool_registry", body.programId);
  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  // ---------------------------------------------------------------------
  // PRE-SEAL: sanity that admin paths still work
  // ---------------------------------------------------------------------

  it("pre-seal: apply_directive succeeds", async () => {
    const beforeState = await body.account.bodyState.fetch(bodyState);
    console.log(`    body.authority = ${beforeState.authority.toBase58()}`);
    expect(beforeState.authority.toBase58()).to.equal(wallet.publicKey.toBase58());

    const directive = {
      executionMode: { execute: {} } as any,
      feeAdjustment: new BN(1234),
      spreadAdjustment: new BN(0),
      throttleFactor: 10_000,
      mintBurnDelta: new BN(0),
      collateralRatioTarget: 0,
    };

    await withRetry("apply", () =>
      body.methods
        .applyDirective(directive, price(1.0), new BN(9000))
        .accounts({
          bodyState,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" })
    );

    const after = await body.account.bodyState.fetch(bodyState);
    expect(after.currentDirective.feeAdjustment.toNumber()).to.equal(1234);
    console.log("    ✓ apply_directive worked pre-seal");
  });

  // ---------------------------------------------------------------------
  // SEAL
  // ---------------------------------------------------------------------

  it("seal_body — deployer surrenders authority", async () => {
    await withRetry("seal", () =>
      body.methods
        .sealBody()
        .accounts({
          bodyState,
          poolRegistry,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" })
    );

    const after = await body.account.bodyState.fetch(bodyState);
    const reg = await body.account.poolRegistry.fetch(poolRegistry);

    console.log(`    body.authority post-seal:     ${after.authority.toBase58()}`);
    console.log(`    registry.authority post-seal: ${reg.authority.toBase58()}`);

    expect(after.authority.toBase58()).to.equal(PublicKey.default.toBase58());
    expect(reg.authority.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  // ---------------------------------------------------------------------
  // POST-SEAL: admin paths dead
  // ---------------------------------------------------------------------

  it("post-seal: apply_directive is dead", async () => {
    const directive = {
      executionMode: { halt: {} } as any,
      feeAdjustment: new BN(0),
      spreadAdjustment: new BN(0),
      throttleFactor: 10_000,
      mintBurnDelta: new BN(0),
      collateralRatioTarget: 0,
    };

    let rejected = false;
    try {
      await body.methods
        .applyDirective(directive, price(1.0), new BN(9001))
        .accounts({
          bodyState,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      rejected = String(e).includes("Unauthorized") || String(e).includes("constraint");
    }
    expect(rejected).to.equal(true);
    console.log("    ✓ apply_directive rejected — admin power surrendered");
  });

  it("post-seal: register_pool is dead", async () => {
    const fakePool = anchor.web3.Keypair.generate().publicKey;
    let rejected = false;
    let errStr = "";
    try {
      await body.methods
        .registerPool(fakePool)
        .accounts({
          poolRegistry,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      errStr = String(e);
      rejected = errStr.includes("Unauthorized") || errStr.includes("constraint") || errStr.includes("Error");
    }
    if (!rejected) console.log("    ! unexpectedly succeeded; error string was:", errStr);
    expect(rejected).to.equal(true);
    console.log("    ✓ register_pool rejected — registry frozen");
  });

  // ---------------------------------------------------------------------
  // POST-SEAL: brain-driven heartbeat still works
  // ---------------------------------------------------------------------

  it("post-seal: heartbeat (brain CPI) still updates body directive", async () => {
    await withRetry("hb", () =>
      body.methods
        .heartbeat(price(0.995), 1, new BN(9100))
        .accounts({
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

    const state = await body.account.bodyState.fetch(bodyState);
    console.log(`    fee=${state.currentDirective.feeAdjustment.toNumber()} mode=${JSON.stringify(state.currentDirective.executionMode)} slot=${state.lastSlot.toNumber()}`);

    // At price=0.995, severity=0.5, fee = f0 + s*lambda = 3000 + 25000 = 28000
    expect(state.currentDirective.feeAdjustment.toNumber()).to.be.closeTo(28_000, 100);
    expect(state.lastSlot.toNumber()).to.equal(9100);
    console.log("    ✓ heartbeat works post-seal — body lives by the brain alone");
  });

  // ---------------------------------------------------------------------
  // POST-SEAL: re-seal must fail
  // ---------------------------------------------------------------------

  it("post-seal: seal_body cannot be called again", async () => {
    let rejected = false;
    try {
      await body.methods
        .sealBody()
        .accounts({
          bodyState,
          poolRegistry,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      rejected = String(e).includes("Unauthorized") || String(e).includes("constraint");
    }
    expect(rejected).to.equal(true);
    console.log("    ✓ re-sealing rejected — handoff is permanent");
  });
});
