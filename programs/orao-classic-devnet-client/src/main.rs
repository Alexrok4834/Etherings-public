use std::{env, error::Error, io::Write, sync::Arc};

use anchor_client::{
    solana_sdk::{commitment_config::CommitmentConfig, signature::read_keypair_file, signer::Signer},
    Client, Cluster,
};
use orao_solana_vrf::{
    get_network_state, get_randomness, randomness_account_address, state::RandomnessV2,
    RequestBuilder,
};

const REQUEST_SPACE: usize = 8 + RandomnessV2::PENDING_SIZE;

fn seed_from_hex(value: &str) -> Result<[u8; 32], Box<dyn Error>> {
    let bytes = hex::decode(value)?;
    bytes.try_into().map_err(|_| "seed must be 32 bytes".into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mode = args
        .next()
        .ok_or("usage: inspect | request SEED_HEX | observe SEED_HEX | replay SEED_HEX")?;
    let payer_path = env::var("ORAO_TEST_PAYER_KEY")?;
    let payer = Arc::new(read_keypair_file(&payer_path)?);
    let payer_address = payer.pubkey();
    let client = Client::new_with_options(Cluster::Devnet, payer, CommitmentConfig::confirmed());
    let program = client.program(orao_solana_vrf::id())?;

    match mode.as_str() {
        "inspect" => {
            let state = get_network_state(&program).await?;
            let balance = program.rpc().get_balance(&payer_address).await?;
            let rent = program.rpc().get_minimum_balance_for_rent_exemption(REQUEST_SPACE).await?;
            println!("program={}", orao_solana_vrf::id());
            println!("payer={payer_address}");
            println!("payer_lamports={balance}");
            println!("treasury={}", state.config.treasury);
            println!("request_fee_lamports={}", state.config.request_fee);
            println!("request_rent_{REQUEST_SPACE}_lamports={rent}");
        }
        "request" => {
            let seed = seed_from_hex(&args.next().ok_or("missing seed")?)?;
            let state = get_network_state(&program).await?;
            let rent = program.rpc().get_minimum_balance_for_rent_exemption(REQUEST_SPACE).await?;
            let balance = program.rpc().get_balance(&payer_address).await?;
            let required = rent + state.config.request_fee + 100_000;
            if balance < required {
                return Err(format!("insufficient test SOL: balance={balance}, required={required}").into());
            }
            let address = randomness_account_address(&orao_solana_vrf::id(), &seed);
            let existing = program
                .rpc()
                .get_account_with_commitment(&address, CommitmentConfig::confirmed())
                .await?;
            if existing.value.is_some() {
                return Err("request PDA already exists; do not issue a replacement seed".into());
            }
            println!("seed_hex={}", hex::encode(seed));
            println!("request_pda={address}");
            println!("payer={payer_address}");
            std::io::stdout().flush()?;
            let signature = RequestBuilder::new(seed).build(&program).await?.send().await?;
            println!("request_signature={signature}");
        }
        "observe" => {
            let seed = seed_from_hex(&args.next().ok_or("missing seed")?)?;
            let address = randomness_account_address(&orao_solana_vrf::id(), &seed);
            let request = get_randomness(&program, &seed).await?;
            println!("request_pda={address}");
            println!("request_version={:?}", request.version());
            println!("request_client={:?}", request.client());
            println!("seed_matches={}", request.seed() == &seed);
            match request.fulfilled_randomness() {
                Some(randomness) => println!("fulfilled_randomness_hex={}", hex::encode(randomness)),
                None => println!("status=pending"),
            }
        }
        "replay" => {
            let seed = seed_from_hex(&args.next().ok_or("missing seed")?)?;
            let transaction = RequestBuilder::new(seed)
                .build(&program)
                .await?
                .signed_transaction()
                .await?;
            let simulation = program.rpc().simulate_transaction(&transaction).await?;
            println!("simulation_error={:?}", simulation.value.err);
            for log in simulation.value.logs.unwrap_or_default() {
                println!("simulation_log={log}");
            }
            if simulation.value.err.is_none() {
                return Err("replay simulation unexpectedly succeeded".into());
            }
        }
        _ => return Err("unknown mode".into()),
    }
    Ok(())
}
