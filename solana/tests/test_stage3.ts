import * as anchor from "@anchor-lang/core";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccount,
  transferChecked,
  getAccount,
  getMint,
} from "@solana/spl-token";

import assert from "assert";

import idl from "../target/idl/explorechem_rwa_solana.json";

// ================================================================
// EXPLORECHEM
// ================================================================

const SEPOLIA_CHAIN_ID =
  new anchor.BN(11_155_111);

const EXPLORECHEM_LOTS =
  Array.from(
    Buffer.from(
      "191F35b0E823319B167E7E0ffEb7BB442f9b396F",
      "hex"
    )
  );

const SERIES_ID =
  Array(32).fill(0x51);

const ISSUER_ACTOR_ID =
  Array(32).fill(0x52);

const ORIGIN_COMMITMENT =
  Array(32).fill(0x53);

const CLAIM_COMMITMENT =
  Array(32).fill(0x54);

const HOLDER_B_ACTOR_ID =
  Array(32).fill(0x61);

const SETTLEMENT_HASH =
  Array(32).fill(0x77);

// ================================================================
// TESTE
// ================================================================

describe(
  "ExploreChem RWA - Final Economic Flow",
  () => {
    const provider =
      anchor.AnchorProvider.env();

    anchor.setProvider(provider);

    const program =
      new anchor.Program(
        idl as anchor.Idl,
        provider
      ) as any;

    const connection =
      provider.connection;

    const payer =
      provider.wallet.publicKey;

    const trustedAttestor =
      Keypair.generate();

    const wrongAttestor =
      Keypair.generate();

    const holderA =
      Keypair.generate();

    const holderB =
      Keypair.generate();

    let configPda: PublicKey;
    let seriesPda: PublicKey;
    let originLockPda: PublicKey;
    let nonceRecordPda: PublicKey;

    let mintRecordPda: PublicKey;
    let mintPda: PublicKey;

    let holderATokenAccount: PublicKey;
    let holderBTokenAccount: PublicKey;

    let redemptionPda: PublicKey;
    let escrowTokenAccount: PublicKey;

    // ============================================================
    // HELPERS
    // ============================================================

    async function sleep(
      ms: number
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, ms)
      );
    }

    async function airdrop(
      pubkey: PublicKey,
      sol: number = 2
    ) {
      const sig =
        await connection.requestAirdrop(
          pubkey,
          sol * LAMPORTS_PER_SOL
        );

      await connection.confirmTransaction(
        sig,
        "confirmed"
      );
    }

    async function expectFailure(
      fn: () => Promise<unknown>
    ) {
      let failed = false;

      try {
        await fn();
      } catch (_) {
        failed = true;
      }

      assert.strictEqual(
        failed,
        true,
        "A operacao deveria falhar"
      );
    }

    async function waitForAccount(
      address: PublicKey,
      description: string,
      attempts: number = 30
    ) {
      for (
        let i = 0;
        i < attempts;
        i++
      ) {
        const account =
          await connection.getAccountInfo(
            address,
            "confirmed"
          );

        if (account !== null) {
          return account;
        }

        await sleep(100);
      }

      throw new Error(
        `${description} nao apareceu no validator`
      );
    }

    // ============================================================
    // SETUP
    // ============================================================

    before(async () => {
      await airdrop(
        trustedAttestor.publicKey
      );

      await airdrop(
        wrongAttestor.publicKey
      );

      await airdrop(
        holderA.publicKey
      );

      await airdrop(
        holderB.publicKey
      );

      // CONFIG
      [configPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("config"),
          ],
          program.programId
        );

      // SERIES
      [seriesPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("series"),
            Buffer.from(
              SERIES_ID
            ),
          ],
          program.programId
        );

      // ORIGIN
      [originLockPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("origin"),
            Buffer.from(
              ORIGIN_COMMITMENT
            ),
          ],
          program.programId
        );

      // NONCE
      const nonce =
        new anchor.BN(500);

      const nonceBuffer =
        nonce.toArrayLike(
          Buffer,
          "le",
          8
        );

      [nonceRecordPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("nonce"),
            nonceBuffer,
          ],
          program.programId
        );

      // SERIES -> MINT RECORD
      [mintRecordPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("rwa-mint"),
            Buffer.from(
              SERIES_ID
            ),
          ],
          program.programId
        );

      // TOKEN-2022 MINT
      [mintPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("mint"),
            Buffer.from(
              SERIES_ID
            ),
          ],
          program.programId
        );

      // HOLDER A ATA
      holderATokenAccount =
        getAssociatedTokenAddressSync(
          mintPda,
          holderA.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

      // REDEMPTION PDA
      [redemptionPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("redemption"),
            Buffer.from(
              SERIES_ID
            ),
          ],
          program.programId
        );

      // ESCROW ATA
      //
      // Redemption é PDA, portanto:
      // allowOwnerOffCurve = true
      escrowTokenAccount =
        getAssociatedTokenAddressSync(
          mintPda,
          redemptionPda,
          true,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
    });

    // ============================================================
    // 1. INITIALIZE
    // ============================================================

    it(
      "initializes config",
      async () => {
        await program.methods
          .initialize(
            trustedAttestor.publicKey,
            SEPOLIA_CHAIN_ID,
            EXPLORECHEM_LOTS
          )
          .accounts({
            authority:
              payer,

            config:
              configPda,

            systemProgram:
              SystemProgram.programId,
          })
          .rpc({
            commitment:
              "confirmed",
          });

        console.log(
          "✅ Config criada"
        );
      }
    );

    // ============================================================
    // 2. CREATE SERIES
    // ============================================================

    it(
      "creates Series",
      async () => {
        const args = {
          version: 1,

          seriesId:
            SERIES_ID,

          issuerActorId:
            ISSUER_ACTOR_ID,

          originCommitment:
            ORIGIN_COMMITMENT,

          claimCommitment:
            CLAIM_COMMITMENT,

          sourceChainId:
            SEPOLIA_CHAIN_ID,

          sourceLotsContract:
            EXPLORECHEM_LOTS,

          nonce:
            new anchor.BN(500),

          expiresAt:
            new anchor.BN(
              4_000_000_000
            ),
        };

        await program.methods
          .increment(args)
          .accounts({
            payer,

            config:
              configPda,

            trustedAttestor:
              trustedAttestor.publicKey,

            series:
              seriesPda,

            originLock:
              originLockPda,

            nonceRecord:
              nonceRecordPda,

            systemProgram:
              SystemProgram.programId,
          })
          .signers([
            trustedAttestor,
          ])
          .rpc({
            commitment:
              "confirmed",
          });

        const series =
          await program.account
            .series
            .fetch(
              seriesPda
            );

        assert.strictEqual(
          series.economicStatus,
          1
        );

        assert.strictEqual(
          series.verificationStatus,
          1
        );

        console.log(
          "✅ Series ACTIVE + PENDING"
        );
      }
    );

    // ============================================================
    // 3. MINT PARA HOLDER A
    // ============================================================

    it(
      "mints RWA to holder A",
      async () => {
        const mintSignature =
          await program.methods
            .mintRwa()
            .accounts({
              payer,

              config:
                configPda,

              trustedAttestor:
                trustedAttestor.publicKey,

              series:
                seriesPda,

              holder:
                holderA.publicKey,

              mintRecord:
                mintRecordPda,

              mint:
                mintPda,

              holderTokenAccount:
                holderATokenAccount,

              tokenProgram:
                TOKEN_2022_PROGRAM_ID,

              associatedTokenProgram:
                ASSOCIATED_TOKEN_PROGRAM_ID,

              systemProgram:
                SystemProgram.programId,
            })
            .signers([
              trustedAttestor,
            ])
            .rpc({
              commitment:
                "confirmed",
            });

        await connection
          .confirmTransaction(
            mintSignature,
            "confirmed"
          );

        // Evita a corrida que aconteceu no teste anterior.
        await waitForAccount(
          mintPda,
          "Mint Token-2022"
        );

        await waitForAccount(
          holderATokenAccount,
          "ATA do Holder A"
        );

        await waitForAccount(
          mintRecordPda,
          "RwaMintRecord"
        );

        const mint =
          await getMint(
            connection,
            mintPda,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          mint.supply,
          1n
        );

        assert.strictEqual(
          mint.decimals,
          0
        );

        assert.strictEqual(
          mint.mintAuthority,
          null
        );

        assert.strictEqual(
          mint.freezeAuthority,
          null
        );

        const accountA =
          await getAccount(
            connection,
            holderATokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          accountA.amount,
          1n
        );

        assert(
          accountA.owner.equals(
            holderA.publicKey
          )
        );

        console.log(
          "✅ Token-2022 criado"
        );

        console.log(
          "✅ supply = 1"
        );

        console.log(
          "✅ Holder A possui o RWA"
        );
      }
    );

    // ============================================================
    // 4. A TRANSFERE O RWA PARA B
    // ============================================================

    it(
      "transfers economic right from A to B",
      async () => {
        // IMPORTANTE:
        //
        // Assinatura correta de createAssociatedTokenAccount:
        //
        // connection
        // payer
        // mint
        // owner
        // confirmOptions
        // token program
        // associated token program
        //
        // O teste anterior tinha os parâmetros deslocados.

        holderBTokenAccount =
          await createAssociatedTokenAccount(
            connection,
            holderB,
            mintPda,
            holderB.publicKey,

            {
              commitment:
                "confirmed",
            },

            TOKEN_2022_PROGRAM_ID,

            ASSOCIATED_TOKEN_PROGRAM_ID
          );

        await waitForAccount(
          holderBTokenAccount,
          "ATA do Holder B"
        );

        const transferSignature =
          await transferChecked(
            connection,

            // Holder A paga a transação.
            holderA,

            holderATokenAccount,

            mintPda,

            holderBTokenAccount,

            // Holder A é autoridade da origem.
            holderA,

            1n,

            // decimals
            0,

            [],

            {
              commitment:
                "confirmed",
            },

            TOKEN_2022_PROGRAM_ID
          );

        await connection
          .confirmTransaction(
            transferSignature,
            "confirmed"
          );

        const accountA =
          await getAccount(
            connection,
            holderATokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        const accountB =
          await getAccount(
            connection,
            holderBTokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          accountA.amount,
          0n
        );

        assert.strictEqual(
          accountB.amount,
          1n
        );

        assert(
          accountB.owner.equals(
            holderB.publicKey
          )
        );

        console.log(
          "✅ A deixou de possuir o RWA"
        );

        console.log(
          "✅ B agora possui o RWA"
        );

        console.log(
          "✅ Direito economico acompanhou o holder atual"
        );
      }
    );

    // ============================================================
    // 5. HOLDER B PEDE REDEMPTION
    // ============================================================

    it(
      "moves B's RWA into redemption escrow",
      async () => {
        assert(
          holderBTokenAccount,
          "ATA do Holder B deveria existir"
        );

        const redemptionSignature =
          await program.methods
            .requestRedemption(
              HOLDER_B_ACTOR_ID
            )
            .accounts({
              holder:
                holderB.publicKey,

              config:
                configPda,

              series:
                seriesPda,

              mintRecord:
                mintRecordPda,

              mint:
                mintPda,

              holderTokenAccount:
                holderBTokenAccount,

              redemption:
                redemptionPda,

              escrowTokenAccount,

              tokenProgram:
                TOKEN_2022_PROGRAM_ID,

              associatedTokenProgram:
                ASSOCIATED_TOKEN_PROGRAM_ID,

              systemProgram:
                SystemProgram.programId,
            })
            .signers([
              holderB,
            ])
            .rpc({
              commitment:
                "confirmed",
            });

        await connection
          .confirmTransaction(
            redemptionSignature,
            "confirmed"
          );

        await waitForAccount(
          redemptionPda,
          "Redemption PDA"
        );

        await waitForAccount(
          escrowTokenAccount,
          "Escrow Token Account"
        );

        const accountB =
          await getAccount(
            connection,
            holderBTokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        const escrow =
          await getAccount(
            connection,
            escrowTokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          accountB.amount,
          0n
        );

        assert.strictEqual(
          escrow.amount,
          1n
        );

        assert(
          escrow.owner.equals(
            redemptionPda
          )
        );

        const redemption =
          await program.account
            .redemption
            .fetch(
              redemptionPda
            );

        // REQUESTED
        assert.strictEqual(
          redemption.status,
          1
        );

        assert(
          redemption
            .holderWallet
            .equals(
              holderB.publicKey
            )
        );

        assert.deepStrictEqual(
          Array.from(
            redemption.holderActorId
          ),
          HOLDER_B_ACTOR_ID
        );

        console.log(
          "✅ B pediu redemption"
        );

        console.log(
          "✅ B nao possui mais o token"
        );

        console.log(
          "✅ RWA esta travado no escrow"
        );

        console.log(
          "✅ Escrow controlado pela Redemption PDA"
        );
      }
    );

    // ============================================================
    // 6. ATTESTOR ERRADO NÃO PODE SETTLE
    // ============================================================

    it(
      "rejects settlement by wrong attestor",
      async () => {
        // Aqui agora a Redemption já existe.
        //
        // Portanto o teste realmente valida o attestor errado,
        // e não apenas uma conta ainda não inicializada.

        await expectFailure(
          async () => {
            await program.methods
              .settleAndBurn(
                SETTLEMENT_HASH
              )
              .accounts({
                config:
                  configPda,

                trustedAttestor:
                  wrongAttestor.publicKey,

                series:
                  seriesPda,

                mintRecord:
                  mintRecordPda,

                mint:
                  mintPda,

                redemption:
                  redemptionPda,

                holder:
                  holderB.publicKey,

                escrowTokenAccount,

                tokenProgram:
                  TOKEN_2022_PROGRAM_ID,
              })
              .signers([
                wrongAttestor,
              ])
              .rpc({
                commitment:
                  "confirmed",
              });
          }
        );

        // Confirma que a transação inválida
        // não queimou o ativo.
        const mint =
          await getMint(
            connection,
            mintPda,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          mint.supply,
          1n
        );

        const escrow =
          await getAccount(
            connection,
            escrowTokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          escrow.amount,
          1n
        );

        const redemption =
          await program.account
            .redemption
            .fetch(
              redemptionPda
            );

        assert.strictEqual(
          redemption.status,
          1
        );

        console.log(
          "✅ Attestor errado nao consegue liquidar"
        );

        console.log(
          "✅ supply continua 1"
        );

        console.log(
          "✅ Token continua no escrow"
        );
      }
    );

    // ============================================================
    // 7. SETTLEMENT CONFIRMADO -> BURN
    // ============================================================

    it(
      "settles payment and burns the RWA",
      async () => {
        const settlementSignature =
          await program.methods
            .settleAndBurn(
              SETTLEMENT_HASH
            )
            .accounts({
              config:
                configPda,

              trustedAttestor:
                trustedAttestor.publicKey,

              series:
                seriesPda,

              mintRecord:
                mintRecordPda,

              mint:
                mintPda,

              redemption:
                redemptionPda,

              holder:
                holderB.publicKey,

              escrowTokenAccount,

              tokenProgram:
                TOKEN_2022_PROGRAM_ID,
            })
            .signers([
              trustedAttestor,
            ])
            .rpc({
              commitment:
                "confirmed",
            });

        await connection
          .confirmTransaction(
            settlementSignature,
            "confirmed"
          );

        // --------------------------------------------------------
        // TOKEN BURN: SUPPLY 1 -> 0
        // --------------------------------------------------------

        const mint =
          await getMint(
            connection,
            mintPda,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          mint.supply,
          0n
        );

        // --------------------------------------------------------
        // SERIES ACTIVE -> REDEEMED
        // --------------------------------------------------------

        const series =
          await program.account
            .series
            .fetch(
              seriesPda
            );

        assert.strictEqual(
          series.economicStatus,
          2
        );

        // --------------------------------------------------------
        // REDEMPTION REQUESTED -> SETTLED
        // --------------------------------------------------------

        const redemption =
          await program.account
            .redemption
            .fetch(
              redemptionPda
            );

        assert.strictEqual(
          redemption.status,
          2
        );

        assert.deepStrictEqual(
          Array.from(
            redemption.settlementHash
          ),
          SETTLEMENT_HASH
        );

        assert(
          redemption.settledAt
            .toNumber() > 0
        );

        // --------------------------------------------------------
        // ESCROW FOI FECHADO
        // --------------------------------------------------------

        const escrow =
          await connection
            .getAccountInfo(
              escrowTokenAccount,
              "confirmed"
            );

        assert.strictEqual(
          escrow,
          null
        );

        console.log(
          "✅ Settlement confirmado"
        );

        console.log(
          "✅ Token-2022 queimado"
        );

        console.log(
          "✅ supply = 0"
        );

        console.log(
          "✅ escrow encerrado"
        );

        console.log(
          "✅ Redemption = SETTLED"
        );

        console.log(
          "✅ Series = REDEEMED"
        );

        console.log(
          "✅ Direito economico extinto"
        );
      }
    );
  }
);