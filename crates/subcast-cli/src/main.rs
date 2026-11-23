fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--asr-worker") {
        std::process::exit(subcast_core::asr::worker_main(&args[2..]));
    }
    println!("subcast CLI initializing");
}
