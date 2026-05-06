import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;

function price(dollars: number): BN {
  return new BN(Math.round(dollars * PRICE_SCALE));
}

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

async function sendAndMeasure(
  program: Program<OrganismBrain>,
  provider: anchor.AnchorProvider,
  accounts: any,
  priceVal: BN,
  direction: number,
  slot: BN
): Promise<number | string> {
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

  const tx = await program.methods
    .evaluateTransaction(priceVal, direction, slot)
    .accounts(accounts)
    .preInstructions([cuLimitIx])
    .rpc({ commitment: "confirmed" });

  await new Promise(r => setTimeout(r, 2000));

  const txDetail = await provider.connection.getTransaction(tx, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  return txDetail?.meta?.computeUnitsConsumed ?? "?";
}

describe("CU measurement — devnet (sustained)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const programId = program.programId;

  const paramsPda = findPda("params", programId);
  const severityPda = findPda("severity", programId);
  const ladderPda = findPda("ladder", programId);
  const intensityPda = findPda("intensity", programId);

  const accounts = {
    severity: severityPda,
    ladder: ladderPda,
    intensity: intensityPda,
    params: paramsPda,
  };

  // Run 10 heartbeats per test to avoid blockhash expiry
  for (let batch = 0; batch < 4; batch++) {
    it(`sustained attack batch ${batch + 1} (ticks ${batch * 5 + 1}-${batch * 5 + 5})`, async () => {
      for (let i = 0; i < 5; i++) {
        const tick = batch * 5 + i;
        const slot = new BN(100 + tick);
        const cu = await sendAndMeasure(program, provider, accounts, price(0.700), 1, slot);
        const [ladder, intensity] = await Promise.all([
          program.account.ladderState.fetch(ladderPda),
          program.account.intensityState.fetch(intensityPda),
        ]);
        const rung = ladder.rung;
        const ir = rung > 0 ? intensity.values[rung - 1].toNumber() : 0;
        console.log(
          `    tick ${String(tick + 1).padStart(2)}  CU: ${String(cu).padStart(6)}  rung: ${rung}  I: ${(ir / 1_000_000).toFixed(4)}`
        );
      }
    });
  }
});
