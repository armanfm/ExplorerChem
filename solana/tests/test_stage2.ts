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
  getMint,
  getAccount,
} from "@solana/spl-token";

import assert from "assert";

import idl from "../target/idl/explorechem_rwa_solana.json";

// ================================================================
// CONSTANTES EXPLORECHEM
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
  Array(32).fill(0x11);

const ISSUER_ACTOR_ID =
  Array(32).fill(0x22);

const ORIGIN_COMMITMENT =
  Array(32).fill(0x33);

const CLAIM_COMMITMENT =
  Array(32).fill(0x44);

// ================================================================
// TESTE
// ================================================================

describe(
  "ExploreChem RWA - Stage 2",
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

    const trustedAttestor =
      Keypair.generate();

    const wrongAttestor =
      Keypair.generate();

    const holder =
      Keypair.generate();

    const payer =
      provider.wallet.publicKey;

    let configPda: PublicKey;

    let seriesPda: PublicKey;

    let originLockPda: PublicKey;

    let nonceRecordPda: PublicKey;

    let mintRecordPda: PublicKey;

    let mintPda: PublicKey;

    let holderTokenAccount: PublicKey;

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
      sol: number = 1
    ) {
      const signature =
        await connection.requestAirdrop(
          pubkey,
          sol * LAMPORTS_PER_SOL
        );

      await connection.confirmTransaction(
        signature,
        "confirmed"
      );
    }

    async function expectFailure(
      fn: () => Promise<unknown>,
      description: string
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
        `${description}: deveria falhar`
      );
    }

    // Espera uma conta aparecer no validator.
    //
    // Isso evita o TokenAccountNotFoundError
    // logo depois da criação do mint/ATA.
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
    // PREPARAÇÃO
    // ============================================================

    before(async () => {
      await airdrop(
        trustedAttestor.publicKey
      );

      await airdrop(
        wrongAttestor.publicKey
      );

      await airdrop(
        holder.publicKey
      );

      // ----------------------------------------------------------
      // CONFIG PDA
      // ----------------------------------------------------------

      [configPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("config"),
          ],
          program.programId
        );

      // ----------------------------------------------------------
      // SERIES PDA
      // ----------------------------------------------------------

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

      // ----------------------------------------------------------
      // ORIGIN LOCK PDA
      // ----------------------------------------------------------

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

      // ----------------------------------------------------------
      // NONCE PDA
      // ----------------------------------------------------------

      const nonce =
        new anchor.BN(100);

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

      // ----------------------------------------------------------
      // RWA MINT RECORD PDA
      // ----------------------------------------------------------

      [mintRecordPda] =
        PublicKey.findProgramAddressSync(
          [
            Buffer.from(
              "rwa-mint"
            ),
            Buffer.from(
              SERIES_ID
            ),
          ],
          program.programId
        );

      // ----------------------------------------------------------
      // TOKEN-2022 MINT PDA
      // ----------------------------------------------------------

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

      // ----------------------------------------------------------
      // TOKEN-2022 ATA DO HOLDER
      // ----------------------------------------------------------

      holderTokenAccount =
        getAssociatedTokenAddressSync(
          mintPda,
          holder.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
    });

    // ============================================================
    // 1. INITIALIZE
    // ============================================================

    it(
      "initializes ExploreChem RWA config",
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

        const config =
          await program.account
            .config
            .fetch(
              configPda
            );

        assert(
          config
            .trustedAttestor
            .equals(
              trustedAttestor.publicKey
            )
        );

        assert.strictEqual(
          config
            .sourceChainId
            .toString(),

          SEPOLIA_CHAIN_ID
            .toString()
        );

        assert.deepStrictEqual(
          Array.from(
            config
              .sourceLotsContract
          ),
          EXPLORECHEM_LOTS
        );

        assert.strictEqual(
          config.paused,
          false
        );

        console.log(
          "✅ Config criada"
        );
      }
    );

    // ============================================================
    // 2. CREATE SERIES
    // ============================================================

    it(
      "creates ACTIVE + PENDING Series",
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
            new anchor.BN(100),

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

        assert.deepStrictEqual(
          Array.from(
            series.seriesId
          ),
          SERIES_ID
        );

        assert.deepStrictEqual(
          Array.from(
            series.issuerActorId
          ),
          ISSUER_ACTOR_ID
        );

        // ACTIVE
        assert.strictEqual(
          series.economicStatus,
          1
        );

        // PENDING
        assert.strictEqual(
          series.verificationStatus,
          1
        );

        const origin =
          await connection
            .getAccountInfo(
              originLockPda,
              "confirmed"
            );

        const nonce =
          await connection
            .getAccountInfo(
              nonceRecordPda,
              "confirmed"
            );

        assert(
          origin !== null
        );

        assert(
          nonce !== null
        );

        console.log(
          "✅ Series ACTIVE + PENDING"
        );

        console.log(
          "✅ OriginLock criado"
        );

        console.log(
          "✅ NonceRecord criado"
        );
      }
    );

    // ============================================================
    // 3. MINT TOKEN-2022 ENQUANTO PENDING
    // ============================================================

    it(
      "mints one Token-2022 RWA while PENDING",
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
                holder.publicKey,

              mintRecord:
                mintRecordPda,

              mint:
                mintPda,

              holderTokenAccount,

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

        // --------------------------------------------------------
        // ESPERA TRANSAÇÃO CONFIRMAR
        // --------------------------------------------------------

        await connection
          .confirmTransaction(
            mintSignature,
            "confirmed"
          );

        // --------------------------------------------------------
        // ESPERA CONTAS APARECEREM
        // --------------------------------------------------------

        await waitForAccount(
          mintPda,
          "Mint Token-2022"
        );

        await waitForAccount(
          holderTokenAccount,
          "ATA do holder"
        );

        await waitForAccount(
          mintRecordPda,
          "RwaMintRecord"
        );

        console.log(
          "✅ Transacao de mint confirmada"
        );

        // --------------------------------------------------------
        // CONFERE MINT
        // --------------------------------------------------------

        const mint =
          await getMint(
            connection,
            mintPda,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert.strictEqual(
          mint.decimals,
          0
        );

        assert.strictEqual(
          mint.supply,
          1n
        );

        // mint authority removida
        assert.strictEqual(
          mint.mintAuthority,
          null
        );

        // freeze authority removida
        assert.strictEqual(
          mint.freezeAuthority,
          null
        );

        console.log(
          "✅ Token-2022 criado"
        );

        console.log(
          "✅ decimals = 0"
        );

        console.log(
          "✅ supply = 1"
        );

        console.log(
          "✅ mint authority = NONE"
        );

        console.log(
          "✅ freeze authority = NONE"
        );

        // --------------------------------------------------------
        // CONFERE TOKEN ACCOUNT DO HOLDER
        // --------------------------------------------------------

        const tokenAccount =
          await getAccount(
            connection,
            holderTokenAccount,
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        assert(
          tokenAccount.owner.equals(
            holder.publicKey
          )
        );

        assert(
          tokenAccount.mint.equals(
            mintPda
          )
        );

        assert.strictEqual(
          tokenAccount.amount,
          1n
        );

        console.log(
          "✅ Holder recebeu exatamente 1 RWA"
        );

        // --------------------------------------------------------
        // CONFERE SERIES <-> MINT
        // --------------------------------------------------------

        const mintRecord =
          await program.account
            .rwaMintRecord
            .fetch(
              mintRecordPda
            );

        assert.deepStrictEqual(
          Array.from(
            mintRecord.seriesId
          ),
          SERIES_ID
        );

        assert(
          mintRecord.mint.equals(
            mintPda
          )
        );

        assert(
          mintRecord
            .initialHolder
            .equals(
              holder.publicKey
            )
        );

        console.log(
          "✅ Series vinculada ao mint"
        );
      }
    );

    // ============================================================
    // 4. ATTESTOR ERRADO
    // ============================================================

    it(
      "rejects verification by wrong attestor",
      async () => {
        await expectFailure(
          async () => {
            await program.methods
              .verifySeries()
              .accounts({
                config:
                  configPda,

                trustedAttestor:
                  wrongAttestor.publicKey,

                series:
                  seriesPda,
              })
              .signers([
                wrongAttestor,
              ])
              .rpc({
                commitment:
                  "confirmed",
              });
          },

          "attestor incorreto"
        );

        const series =
          await program.account
            .series
            .fetch(
              seriesPda
            );

        assert.strictEqual(
          series.verificationStatus,
          1
        );

        console.log(
          "✅ Attestor errado bloqueado"
        );

        console.log(
          "✅ Series continua PENDING"
        );
      }
    );

    // ============================================================
    // 5. PENDING -> VERIFIED
    // ============================================================

    it(
      "changes only verification PENDING -> VERIFIED",
      async () => {
        await program.methods
          .verifySeries()
          .accounts({
            config:
              configPda,

            trustedAttestor:
              trustedAttestor.publicKey,

            series:
              seriesPda,
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

        // Economic status continua ACTIVE.
        assert.strictEqual(
          series.economicStatus,
          1
        );

        // Verification passa a VERIFIED.
        assert.strictEqual(
          series.verificationStatus,
          2
        );

        console.log(
          "✅ PENDING -> VERIFIED"
        );

        console.log(
          "✅ economic_status continua ACTIVE"
        );
      }
    );

    // ============================================================
    // 6. NÃO PODE VERIFY DUAS VEZES
    // ============================================================

    it(
      "rejects second verification",
      async () => {
        await expectFailure(
          async () => {
            await program.methods
              .verifySeries()
              .accounts({
                config:
                  configPda,

                trustedAttestor:
                  trustedAttestor.publicKey,

                series:
                  seriesPda,
              })
              .signers([
                trustedAttestor,
              ])
              .rpc({
                commitment:
                  "confirmed",
              });
          },

          "segunda verificacao"
        );

        console.log(
          "✅ Segunda verificacao bloqueada"
        );
      }
    );

    // ============================================================
    // 7. NÃO PODE MINTAR A MESMA SERIES NOVAMENTE
    // ============================================================

    it(
      "rejects second mint for same Series",
      async () => {
        await expectFailure(
          async () => {
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
                  holder.publicKey,

                mintRecord:
                  mintRecordPda,

                mint:
                  mintPda,

                holderTokenAccount,

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
          },

          "segundo mint"
        );

        // Confirma novamente que o supply
        // continua exatamente uma unidade.
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

        console.log(
          "✅ Segundo mint bloqueado"
        );

        console.log(
          "✅ supply continua exatamente 1"
        );
      }
    );
  }
);