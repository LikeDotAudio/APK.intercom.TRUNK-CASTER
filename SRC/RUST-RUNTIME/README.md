# RUST-RUNTIME — the Trunk-Caster program

The plan, the vocabulary, the folder contract and the API are documented in
`../TRUNK-CASTER-SDK/README.md` and `../TRUNK-CASTER-SDK/plans/`. This crate is the runtime that
implements them.

```
cargo run -- discover
cargo run -- advertise
cargo run -- serve --site HQ          # http://127.0.0.1:7878
cargo test
```

Principle: speak by protocol, not by brand. Every switch is a Ward-Beck line:
`SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE`.
