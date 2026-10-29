//! Dev utility: write synthetic book files for manual runs, screenshots and the
//! performance harness. Nothing here ships in the app; it exists so that no
//! copyrighted book is ever committed or needed to exercise the library.
//!
//!   cargo run --bin make-fixtures -- <out-dir> [pdf-count] [epub-count]
//!
//! Titles/authors are varied so every file has a distinct blake3 hash and the
//! shelf gets a realistic spread of thicknesses and spine colours.

use std::path::PathBuf;
use std::process::ExitCode;

use bookshelf_lib::fixtures::{write_epub, EpubOptions};

const AUTHORS: &[&str] = &[
    "Ursula K. Le Guin",
    "Italo Calvino",
    "Toni Morrison",
    "Jorge Luis Borges",
    "Virginia Woolf",
    "Chinua Achebe",
    "Stanisław Lem",
    "Umar Xayyom",
    "山田 太郎",
    "Лев Толстой",
];

const WORDS: &[&str] = &[
    "The", "Quiet", "Ledger", "of", "Small", "Hours", "Winter", "Archive", "Salt", "Roads",
    "Paper", "Cities", "Night", "Garden", "Long", "Division", "Blue", "Field", "Glass", "Bell",
];

fn title_for(index: usize) -> String {
    let a = WORDS[index % WORDS.len()];
    let b = WORDS[(index / WORDS.len() + index * 7) % WORDS.len()];
    let c = WORDS[(index * 3 + 5) % WORDS.len()];
    format!("{a} {b} {c} {:03}", index + 1)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: make-fixtures <out-dir> [pdf-count] [epub-count]");
        return ExitCode::from(2);
    };
    let dir = PathBuf::from(dir);
    let pdfs: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(6);
    let epubs: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(4);

    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("cannot create {}: {err}", dir.display());
        return ExitCode::FAILURE;
    }

    for index in 0..pdfs {
        let title = title_for(index);
        // 40–640 pages so spine thickness varies like a real shelf.
        let pages = 40 + (index * 37) % 600;
        let path = dir.join(format!("pdf-{index:04}.pdf"));
        if let Err(err) = bookshelf_lib::fixtures::write_pdf(&path, pages, &title) {
            eprintln!("pdf write failed: {err}");
            return ExitCode::FAILURE;
        }
    }

    for index in 0..epubs {
        let title = title_for(index + pdfs);
        let chapters: Vec<(String, String)> = (1..=4)
            .map(|n| {
                (
                    format!("Chapter {n}"),
                    format!(
                        "<h1>Chapter {n}</h1><p>{} This is generated text for the fixture library.</p>",
                        "A quiet sentence keeps the page company. ".repeat(12 + n)
                    ),
                )
            })
            .collect();
        let opts = EpubOptions {
            title,
            author: AUTHORS[(index + pdfs) % AUTHORS.len()].to_string(),
            chapters,
            cover: true,
            epub3: index % 2 == 0,
            ..Default::default()
        };
        if let Err(err) = write_epub(&dir, &opts) {
            eprintln!("epub write failed: {err}");
            return ExitCode::FAILURE;
        }
    }

    println!("wrote {pdfs} PDFs and {epubs} EPUBs to {}", dir.display());
    ExitCode::SUCCESS
}
