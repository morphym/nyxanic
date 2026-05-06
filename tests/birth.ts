import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await fn();
      console.log(`    [${label}] ok (attempt ${i})`);
      return result;
    } catch (e: any) {
      const msg = String(e);
      if (msg.includes("already in use")) {
        console.log(`    [${label}] already exists`);
        return null;
      }
      if (msg.includes("Blockhash not found") && i < attempts) {
        console.log(`    [${label}] blockhash retry ${i}/${attempts}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  return null;
}

describe("birth — devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.organismToken as Program<OrganismToken>;
  const programId = program.programId;
  const wallet = provider.wallet as anchor.Wallet;

  const mintPda = findPda("mint", programId);
  const mintAuthority = findPda("mint_authority", programId);
  const reserveVault = findPda("reserve_vault", programId);
  const feeCollector = findPda("fee_collector", programId);
  const bodyState = findPda("body_state", programId);
  const poolRegistry = findPda("pool_registry", programId);

  it("init A1 mint", async () => {
    await withRetry("init_mint", () =>
      program.methods
        .initializeMint()
        .accounts({
          mint: mintPda,
          mintAuthority,
          authority: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" })
    );
    console.log("    mint:", mintPda.toBase58());
  });

  it("init A2-A5 body", async () => {
    await withRetry("init_body", () =>
      program.methods
        .initializeBody()
        .accounts({
          mint: mintPda,
          mintAuthority,
          reserveVault,
          feeCollector,
          bodyState,
          poolRegistry,
          authority: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" })
    );
    console.log("    body_state:", bodyState.toBase58());
    console.log("    reserve_vault:", reserveVault.toBase58());
    console.log("    fee_collector:", feeCollector.toBase58());
  });
});
