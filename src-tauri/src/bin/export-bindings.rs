//! Regenerates `ui/src/bindings.ts` from the Rust command/type definitions.
//! Run with `npm run bindings`; CI fails when the committed file is stale.

fn main() {
    bookshelf_lib::specta_builder()
        .export(
            specta_typescript::Typescript::default(),
            "../ui/src/bindings.ts",
        )
        .expect("could not export TypeScript bindings");
    println!("wrote ui/src/bindings.ts");
}
