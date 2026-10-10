use std::{env, error::Error, io::Write, sync::Arc, time::Duration};

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig, signature::read_keypair_file, signer::Signer,
    },
    Client, Cluster,
};
use orao_classic_cpi_proof::{accounts::Begin, instruction::Begin as BeginIx, OperationState};
use orao_solana_vrf::{get_network_state, get_randomness, randomness_account_address};

fn seed_from_hex(value: &str) -> Result<[u8; 32], Box<dyn Error>> {
    Ok(hex::decode(value)?
        .try_into()
        .map_err(|_| "seed must be 32 bytes")?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mode = args
        .next()
        .ok_or("usage: begin SEED_HEX | observe | replay SEED_HEX")?;
    let payer = Arc::new(read_keypair_file(env::var("ORAO_TEST_PAYER_KEY")?)?);
    let payer_address = payer.pubkey();
    let rpc_url = env::var("ORAO_DEVNET_RPC_URL")?;
    let client = Client::new_with_options(
        Cluster::Custom(rpc_url.clone(), rpc_url),
        payer,
        CommitmentConfig::confirmed(),
    );
    let proof = client.program(orao_classic_cpi_proof::id())?;
    let orao = client.program(orao_solana_vrf::id())?;
    let operation = anchor_client::solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"operation", payer_address.as_ref()],
        &orao_classic_cpi_proof::id(),
    )
    .0;

    if mode == "observe" {
        let state: OperationState = proof.account(operation).await?;
        let request = get_randomness(&orao, &state.seed).await?;
        println!("operation={operation}");
        println!("payer={}", state.payer);
        println!("seed_hex={}", hex::encode(state.seed));
        println!("request_pda={}", state.request);
        println!(
            "expected_request_pda={}",
            randomness_account_address(&orao_solana_vrf::id(), &state.seed)
        );
        println!("request_client={:?}", request.client());
        println!("seed_matches={}", request.seed() == &state.seed);
        match request.fulfilled_randomness() {
            Some(randomness) => println!("fulfilled_randomness_hex={}", hex::encode(randomness)),
            None => println!("status=pending"),
        }
        return Ok(());
    }

    let seed = seed_from_hex(&args.next().ok_or("missing seed")?)?;
    let request = randomness_account_address(&orao_solana_vrf::id(), &seed);
    let network_state = get_network_state(&orao).await?;
    let builder = proof
        .request()
        .accounts(Begin {
            payer: payer_address,
            operation,
            network_state: orao_solana_vrf::network_state_account_address(&orao_solana_vrf::id()),
            treasury: network_state.config.treasury,
            request,
            vrf: orao_solana_vrf::id(),
            system_program: anchor_client::solana_sdk::system_program::id(),
        })
        .args(BeginIx { seed });

    match mode.as_str() {
        "begin" => {
            let balance = proof.rpc().get_balance(&payer_address).await?;
            let operation_rent = proof
                .rpc()
                .get_minimum_balance_for_rent_exemption(8 + OperationState::LEN)
                .await?;
            let request_rent = proof
                .rpc()
                .get_minimum_balance_for_rent_exemption(
                    8 + orao_solana_vrf::state::RandomnessV2::PENDING_SIZE,
                )
                .await?;
            let required =
                operation_rent + request_rent + network_state.config.request_fee + 100_000;
            if balance < required {
                return Err(format!(
                    "insufficient test SOL: balance={balance}, required={required}"
                )
                .into());
            }
            if proof
                .rpc()
                .get_account_with_commitment(&operation, CommitmentConfig::confirmed())
                .await?
                .value
                .is_some()
            {
                return Err("operation already bound; refusing a second request".into());
            }
            println!("operation={operation}");
            println!("request_pda={request}");
            println!("payer={payer_address}");
            println!("balance_before_lamports={balance}");
            println!("operation_rent_lamports={operation_rent}");
            println!("request_rent_lamports={request_rent}");
            println!("orao_fee_lamports={}", network_state.config.request_fee);
            std::io::stdout().flush()?;
            let transaction = builder.signed_transaction().await?;
            let signature = transaction.signatures[0];
            println!("prepared_signature={signature}");
            std::io::stdout().flush()?;
            proof.rpc().send_transaction(&transaction).await?;
            for _ in 0..60 {
                let statuses = proof.rpc().get_signature_statuses(&[signature]).await?;
                if let Some(status) = &statuses.value[0] {
                    if let Some(error) = &status.err {
                        return Err(format!("transaction failed: {error:?}").into());
                    }
                    if status.satisfies_commitment(CommitmentConfig::finalized()) {
                        println!("begin_signature={signature}");
                        println!("finalized_slot={}", status.slot);
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            return Err("transaction outcome unknown after HTTP polling".into());
        }
        "replay" => {
            let transaction = builder.signed_transaction().await?;
            let result = proof.rpc().simulate_transaction(&transaction).await?;
            println!("simulation_error={:?}", result.value.err);
            println!("units_consumed={:?}", result.value.units_consumed);
            for log in result.value.logs.unwrap_or_default() {
                println!("simulation_log={log}");
            }
            if result.value.err.is_none() {
                return Err("repeat begin unexpectedly succeeded".into());
            }
        }
        _ => return Err("unknown mode".into()),
    }
    Ok(())
}
