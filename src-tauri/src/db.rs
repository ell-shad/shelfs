//! SQLite persistence: versioned migrations, book CRUD, progress, bookmarks,
//! annotations and settings. The database is the single source of truth; the
//! book files themselves are never written to.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult, OptionExt};
use crate::models::*;
use crate::util::{now_ms, FoldedText};

const BOOK_COLUMNS: &str = "id, title, author, format, path, content_hash, pages, color, height, \
     depth, status, cover_path, position, shelf, added_at, last_opened_at, progress, locator, \
     missing, encrypted, language, size_bytes";

const SCHEMA_V1: &str = r#"
CREATE TABLE books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    author        TEXT    NOT NULL DEFAULT '',
    format        TEXT    NOT NULL CHECK (format IN ('pdf','epub')),
    path          TEXT    NOT NULL,
    content_hash  TEXT    NOT NULL,
    pages         INTEGER NOT NULL DEFAULT 0,
    color         TEXT    NOT NULL,
    height        REAL    NOT NULL,
    depth         REAL    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'want' CHECK (status IN ('want','reading','read')),
    cover_path    TEXT,
    position      INTEGER NOT NULL,
    added_at      INTEGER NOT NULL,
    last_opened_at INTEGER,
    progress      REAL    NOT NULL DEFAULT 0,
    locator       TEXT,
    missing       INTEGER NOT NULL DEFAULT 0,
    encrypted     INTEGER NOT NULL DEFAULT 0,
    language      TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX books_path_unique ON books(path);
CREATE INDEX books_hash ON books(content_hash);

CREATE TABLE bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    locator    TEXT    NOT NULL,
    page       INTEGER,
    label      TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX bookmarks_book ON bookmarks(book_id);

CREATE TABLE annotations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    locator    TEXT    NOT NULL,
    quote      TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    color      TEXT    NOT NULL DEFAULT 'yellow',
    page       INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX annotations_book ON annotations(book_id);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE reading_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    seconds    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reading_sessions_book ON reading_sessions(book_id);
"#;

const SCHEMA_V2: &str = r#"
CREATE TABLE chapter_text (
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    spine_index INTEGER NOT NULL,
    href        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    PRIMARY KEY (book_id, spine_index)
);
CREATE INDEX books_position ON books(position);
"#;

/// A book can be pinned to a shelf by hand, independently of its position in
/// the reading order.
const SCHEMA_V3: &str = r#"
ALTER TABLE books ADD COLUMN shelf INTEGER;
"#;

pub const MIGRATIONS: &[&str] = &[SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

pub struct Db {
    conn: Connection,
}

#[derive(Debug, Clone)]
pub struct NewBook {
    pub title: String,
    pub author: String,
    pub format: BookFormat,
    pub path: String,
    pub content_hash: String,
    pub pages: i64,
    pub color: String,
    pub height: f64,
    pub depth: f64,
    pub language: Option<String>,
    pub size_bytes: i64,
    pub encrypted: bool,
    pub cover_path: Option<String>,
    pub status: Status,
}

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn schema_version(&self) -> AppResult<i64> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&mut self) -> AppResult<()> {
        let mut current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            let target = (idx + 1) as i64;
            if current < target {
                let tx = self.conn.transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", target)?;
                tx.commit()?;
                current = target;
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- books

    pub fn list_books(&self) -> AppResult<Vec<Book>> {
        let sql = format!("SELECT {BOOK_COLUMNS} FROM books ORDER BY position ASC, id ASC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_book)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_book(&self, id: i64) -> AppResult<Book> {
        let sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE id = ?1");
        self.conn
            .query_row(&sql, params![id], row_to_book)
            .optional()?
            .or_not_found(&format!("book {id}"))
    }

    pub fn insert_book(&self, b: &NewBook) -> AppResult<Book> {
        let next_pos: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM books",
            [],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO books (title, author, format, path, content_hash, pages, color, height, \
             depth, status, cover_path, position, added_at, progress, missing, encrypted, \
             language, size_bytes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, ?14, ?15, ?16)",
            params![
                b.title,
                b.author,
                b.format.as_str(),
                b.path,
                b.content_hash,
                b.pages,
                b.color,
                b.height,
                b.depth,
                b.status.as_str(),
                b.cover_path,
                next_pos,
                now_ms(),
                i64::from(b.encrypted),
                b.language,
                b.size_bytes,
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        self.get_book(id)
    }

    pub fn update_book(&self, id: i64, patch: &BookPatch) -> AppResult<Book> {
        let tx = self.conn.unchecked_transaction()?;
        if let Some(title) = patch.title.as_ref() {
            let t = title.trim();
            if t.is_empty() {
                return Err(AppError::Invalid("A book needs a title".into()));
            }
            tx.execute("UPDATE books SET title = ?1 WHERE id = ?2", params![t, id])?;
        }
        if let Some(author) = patch.author.as_ref() {
            tx.execute(
                "UPDATE books SET author = ?1 WHERE id = ?2",
                params![author.trim(), id],
            )?;
        }
        if let Some(pages) = patch.pages {
            tx.execute(
                "UPDATE books SET pages = ?1 WHERE id = ?2",
                params![pages.clamp(1, 20_000), id],
            )?;
        }
        if let Some(color) = patch.color.as_ref() {
            if !crate::util::is_hex_color(color) {
                return Err(AppError::Invalid("Colour must be #rrggbb".into()));
            }
            tx.execute(
                "UPDATE books SET color = ?1 WHERE id = ?2",
                params![color, id],
            )?;
        }
        if let Some(status) = patch.status {
            tx.execute(
                "UPDATE books SET status = ?1 WHERE id = ?2",
                params![status.as_str(), id],
            )?;
        }
        tx.commit()?;
        self.get_book(id)
    }

    pub fn set_pages(&self, id: i64, pages: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET pages = ?1 WHERE id = ?2",
            params![pages.max(1), id],
        )?;
        Ok(())
    }

    pub fn set_cover(&self, id: i64, cover_path: &str, color: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET cover_path = ?1, color = ?2 WHERE id = ?3",
            params![cover_path, color, id],
        )?;
        Ok(())
    }

    pub fn set_missing(&self, id: i64, missing: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET missing = ?1 WHERE id = ?2",
            params![i64::from(missing), id],
        )?;
        Ok(())
    }

    pub fn set_path(&self, id: i64, path: &str, size: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET path = ?1, size_bytes = ?2, missing = 0 WHERE id = ?3",
            params![path, size, id],
        )?;
        Ok(())
    }

    pub fn delete_book(&self, id: i64) -> AppResult<Book> {
        let book = self.get_book(id)?;
        self.conn
            .execute("DELETE FROM books WHERE id = ?1", params![id])?;
        Ok(book)
    }

    pub fn find_by_hash(&self, hash: &str) -> AppResult<Option<Book>> {
        let sql =
            format!("SELECT {BOOK_COLUMNS} FROM books WHERE content_hash = ?1 ORDER BY id LIMIT 1");
        Ok(self
            .conn
            .query_row(&sql, params![hash], row_to_book)
            .optional()?)
    }

    pub fn find_by_path(&self, path: &str) -> AppResult<Option<Book>> {
        let sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE path = ?1");
        Ok(self
            .conn
            .query_row(&sql, params![path], row_to_book)
            .optional()?)
    }

    /// Move a book so that it occupies `target_index` (0-based) in reading order.
    pub fn reorder(&self, id: i64, target_index: i64) -> AppResult<()> {
        let mut ids: Vec<i64> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM books ORDER BY position ASC, id ASC")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let Some(current) = ids.iter().position(|x| *x == id) else {
            return Err(AppError::NotFound(format!("book {id}")));
        };
        ids.remove(current);
        let target = target_index.clamp(0, ids.len() as i64) as usize;
        ids.insert(target, id);
        let tx = self.conn.unchecked_transaction()?;
        for (pos, book_id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE books SET position = ?1 WHERE id = ?2",
                params![pos as i64, book_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Pin a book to a shelf (0-based across cases) or release it (`None`), so
    /// the packer places it automatically again.
    pub fn set_book_shelf(&self, id: i64, shelf: Option<i64>) -> AppResult<()> {
        if let Some(shelf) = shelf {
            if shelf < 0 {
                return Err(AppError::Invalid("a shelf cannot be negative".into()));
            }
        }
        let changed = self.conn.execute(
            "UPDATE books SET shelf = ?1 WHERE id = ?2",
            params![shelf, id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("book {id}")));
        }
        Ok(())
    }

    pub fn save_progress(&self, id: i64, locator: &Locator, progress: f64) -> AppResult<()> {
        let json = serde_json::to_string(locator)
            .map_err(|e| AppError::Invalid(format!("locator: {e}")))?;
        self.conn.execute(
            "UPDATE books SET locator = ?1, progress = ?2, last_opened_at = ?3 WHERE id = ?4",
            params![json, progress.clamp(0.0, 1.0), now_ms(), id],
        )?;
        Ok(())
    }

    /// Restore of a backup: write progress exactly as saved, without touching
    /// the "opened now" semantics of `mark_opened`.
    pub fn set_restored_state(
        &self,
        id: i64,
        progress: f64,
        locator: Option<&str>,
        last_opened_at: Option<i64>,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET progress = ?1, locator = ?2, last_opened_at = ?3 WHERE id = ?4",
            params![progress.clamp(0.0, 1.0), locator, last_opened_at, id],
        )?;
        Ok(())
    }

    pub fn set_status(&self, id: i64, status: Status) -> AppResult<()> {
        self.conn.execute(
            "UPDATE books SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        Ok(())
    }

    /// Mark the book as opened: bumps last_opened_at and flips Want -> Reading.
    pub fn mark_opened(&self, id: i64) -> AppResult<Book> {
        let book = self.get_book(id)?;
        let status = if book.status == Status::Want {
            Status::Reading
        } else {
            book.status
        };
        self.conn.execute(
            "UPDATE books SET last_opened_at = ?1, status = ?2 WHERE id = ?3",
            params![now_ms(), status.as_str(), id],
        )?;
        self.get_book(id)
    }

    pub fn counts(&self) -> AppResult<StatusCounts> {
        let mut counts = StatusCounts::default();
        let mut stmt = self
            .conn
            .prepare("SELECT status, missing, COUNT(*) FROM books GROUP BY status, missing")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, u32>(2)?,
            ))
        })?;
        for row in rows {
            let (status, missing, n) = row?;
            if missing != 0 {
                counts.missing += n;
            }
            match status.as_str() {
                "want" => counts.want += n,
                "reading" => counts.reading += n,
                "read" => counts.read += n,
                _ => {}
            }
        }
        Ok(counts)
    }

    // -------------------------------------------------------- chapter text

    pub fn replace_chapters(
        &self,
        book_id: i64,
        chapters: &[(u32, String, String, String)],
    ) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM chapter_text WHERE book_id = ?1",
            params![book_id],
        )?;
        for (index, href, title, text) in chapters {
            tx.execute(
                "INSERT OR REPLACE INTO chapter_text (book_id, spine_index, href, title, text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![book_id, index, href, title, text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn search_chapters(
        &self,
        book_id: i64,
        query: &str,
        limit: usize,
    ) -> AppResult<Vec<ChapterSearchHit>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT spine_index, href, title, text FROM chapter_text WHERE book_id = ?1 \
             ORDER BY spine_index",
        )?;
        let rows = stmt.query_map(params![book_id], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut hits = Vec::new();
        for row in rows {
            let (spine_index, href, chapter_title, text) = row?;
            let folded = FoldedText::new(&text);
            for (start, end) in folded.find_all(query) {
                hits.push(ChapterSearchHit {
                    spine_index,
                    href: href.clone(),
                    chapter_title: chapter_title.clone(),
                    text_offset: start,
                    excerpt: crate::util::excerpt_around(&text, start, end - start, 48),
                });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
        Ok(hits)
    }

    /// Characters per chapter, used for per-chapter progress in the reader.
    pub fn chapter_char_counts(
        &self,
        book_id: i64,
    ) -> AppResult<std::collections::HashMap<String, u32>> {
        let mut stmt = self
            .conn
            .prepare("SELECT href, text FROM chapter_text WHERE book_id = ?1")?;
        let rows = stmt.query_map(params![book_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = std::collections::HashMap::new();
        for row in rows {
            let (href, text) = row?;
            out.insert(href, text.chars().count() as u32);
        }
        Ok(out)
    }

    pub fn chapter_text(&self, book_id: i64, href: &str) -> AppResult<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT text FROM chapter_text WHERE book_id = ?1 AND href = ?2 LIMIT 1",
                params![book_id, href],
                |r| r.get(0),
            )
            .optional()?)
    }

    // ------------------------------------------------------------ bookmarks

    pub fn list_bookmarks(&self, book_id: i64) -> AppResult<Vec<Bookmark>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, book_id, locator, page, label, created_at FROM bookmarks \
             WHERE book_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![book_id], |r| {
            let locator: String = r.get(2)?;
            Ok(Bookmark {
                id: r.get(0)?,
                book_id: r.get(1)?,
                locator: parse_locator(&locator),
                page: r.get(3)?,
                label: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn add_bookmark(
        &self,
        book_id: i64,
        locator: &Locator,
        label: &str,
        page: Option<i64>,
    ) -> AppResult<Bookmark> {
        let json = serde_json::to_string(locator).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO bookmarks (book_id, locator, page, label, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![book_id, json, page, label, now_ms()],
        )?;
        let id = self.conn.last_insert_rowid();
        self.conn
            .query_row(
                "SELECT id, book_id, locator, page, label, created_at FROM bookmarks WHERE id = ?1",
                params![id],
                |r| {
                    let locator: String = r.get(2)?;
                    Ok(Bookmark {
                        id: r.get(0)?,
                        book_id: r.get(1)?,
                        locator: parse_locator(&locator),
                        page: r.get(3)?,
                        label: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn remove_bookmark(&self, id: i64) -> AppResult<()> {
        self.conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_bookmark_label(&self, id: i64, label: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE bookmarks SET label = ?1 WHERE id = ?2",
            params![label, id],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------- annotations

    pub fn list_annotations(&self, book_id: i64) -> AppResult<Vec<Annotation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, book_id, locator, quote, note, color, page, created_at, updated_at \
             FROM annotations WHERE book_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![book_id], |r| {
            let locator: String = r.get(2)?;
            Ok(Annotation {
                id: r.get(0)?,
                book_id: r.get(1)?,
                locator: parse_locator(&locator),
                quote: r.get(3)?,
                note: r.get(4)?,
                color: parse_color(&r.get::<_, String>(5)?),
                page: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn add_annotation(&self, book_id: i64, a: &NewAnnotation) -> AppResult<Annotation> {
        let json = serde_json::to_string(&a.locator).unwrap_or_else(|_| "{}".into());
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO annotations (book_id, locator, quote, note, color, page, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![book_id, json, a.quote, a.note, color_str(a.color), a.page, now],
        )?;
        let id = self.conn.last_insert_rowid();
        self.get_annotation(id)
    }

    fn get_annotation(&self, id: i64) -> AppResult<Annotation> {
        self.conn
            .query_row(
                "SELECT id, book_id, locator, quote, note, color, page, created_at, updated_at \
                 FROM annotations WHERE id = ?1",
                params![id],
                |r| {
                    let locator: String = r.get(2)?;
                    Ok(Annotation {
                        id: r.get(0)?,
                        book_id: r.get(1)?,
                        locator: parse_locator(&locator),
                        quote: r.get(3)?,
                        note: r.get(4)?,
                        color: parse_color(&r.get::<_, String>(5)?),
                        page: r.get(6)?,
                        created_at: r.get(7)?,
                        updated_at: r.get(8)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn update_annotation(&self, id: i64, patch: &AnnotationPatch) -> AppResult<Annotation> {
        if let Some(note) = patch.note.as_ref() {
            self.conn.execute(
                "UPDATE annotations SET note = ?1, updated_at = ?2 WHERE id = ?3",
                params![note, now_ms(), id],
            )?;
        }
        if let Some(color) = patch.color {
            self.conn.execute(
                "UPDATE annotations SET color = ?1, updated_at = ?2 WHERE id = ?3",
                params![color_str(color), now_ms(), id],
            )?;
        }
        self.get_annotation(id)
    }

    pub fn remove_annotation(&self, id: i64) -> AppResult<()> {
        self.conn
            .execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ------------------------------------------------------------ sessions

    pub fn start_session(&self, book_id: i64) -> AppResult<i64> {
        self.conn.execute(
            "INSERT INTO reading_sessions (book_id, started_at) VALUES (?1, ?2)",
            params![book_id, now_ms()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn end_session(&self, book_id: i64) -> AppResult<()> {
        let now = now_ms();
        self.conn.execute(
            "UPDATE reading_sessions SET ended_at = ?1, \
             seconds = MAX(0, (?1 - started_at) / 1000) \
             WHERE id = (SELECT id FROM reading_sessions WHERE book_id = ?2 AND ended_at IS NULL \
                         ORDER BY started_at DESC LIMIT 1)",
            params![now, book_id],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ settings

    pub fn load_settings(&self) -> Settings {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'settings'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        raw.and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> AppResult<()> {
        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| AppError::Invalid(format!("settings: {e}")))?;
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES ('settings', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )?;
        Ok(())
    }

    /// Backup payload: books + bookmarks + annotations as JSON.
    pub fn export_payload(&self) -> AppResult<serde_json::Value> {
        let books = self.list_books()?;
        let mut bookmarks = Vec::new();
        let mut annotations = Vec::new();
        for b in &books {
            bookmarks.extend(self.list_bookmarks(b.id)?);
            annotations.extend(self.list_annotations(b.id)?);
        }
        Ok(serde_json::json!({
            "app": "bookshelf",
            "version": 1,
            "exportedAt": now_ms(),
            "settings": self.load_settings(),
            "books": books,
            "bookmarks": bookmarks,
            "annotations": annotations,
        }))
    }
}

fn parse_locator(raw: &str) -> Locator {
    serde_json::from_str(raw).unwrap_or(Locator::Pdf {
        page: 1,
        offset: 0.0,
    })
}

pub fn color_str(color: HighlightColor) -> &'static str {
    match color {
        HighlightColor::Yellow => "yellow",
        HighlightColor::Green => "green",
        HighlightColor::Blue => "blue",
        HighlightColor::Pink => "pink",
    }
}

pub fn parse_color(s: &str) -> HighlightColor {
    match s {
        "green" => HighlightColor::Green,
        "blue" => HighlightColor::Blue,
        "pink" => HighlightColor::Pink,
        _ => HighlightColor::Yellow,
    }
}

fn row_to_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    let format: String = row.get("format")?;
    let status: String = row.get("status")?;
    Ok(Book {
        id: row.get("id")?,
        title: row.get("title")?,
        author: row.get("author")?,
        format: BookFormat::parse(&format).unwrap_or(BookFormat::Pdf),
        path: row.get("path")?,
        content_hash: row.get("content_hash")?,
        pages: row.get("pages")?,
        color: row.get("color")?,
        height: row.get("height")?,
        depth: row.get("depth")?,
        status: Status::parse(&status).unwrap_or_default(),
        cover_path: row.get("cover_path")?,
        cover_url: None,
        position: row.get("position")?,
        shelf: row.get("shelf")?,
        added_at: row.get("added_at")?,
        last_opened_at: row.get("last_opened_at")?,
        progress: row.get("progress")?,
        locator: row.get("locator")?,
        missing: row.get::<_, i64>("missing")? != 0,
        encrypted: row.get::<_, i64>("encrypted")? != 0,
        language: row.get("language")?,
        size_bytes: row.get("size_bytes")?,
    })
}

impl Book {
    pub fn decode_locator(&self) -> Option<Locator> {
        self.locator
            .as_ref()
            .and_then(|raw| serde_json::from_str(raw).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BookPatch, NewAnnotation, TextAnchor};

    fn sample_book(db: &Db, title: &str, hash: &str) -> Book {
        db.insert_book(&NewBook {
            title: title.into(),
            author: "Ursula K. Le Guin".into(),
            format: BookFormat::Epub,
            path: format!("/books/{title}.epub"),
            content_hash: hash.into(),
            pages: 300,
            color: "#5b7a63".into(),
            height: 1.3,
            depth: 0.9,
            language: Some("en".into()),
            size_bytes: 1024,
            encrypted: false,
            cover_path: None,
            status: Status::Want,
        })
        .unwrap()
    }

    #[test]
    fn migrations_apply_once_and_are_idempotent() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as i64);
        // Running the migration routine again must be a no-op.
        let mut db2 = Db::open_in_memory().unwrap();
        db2.migrate().unwrap();
        assert_eq!(db2.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn v1_database_upgrades_to_latest() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        // Simulate an existing v1 library.
        conn.execute(
            "INSERT INTO books (title,author,format,path,content_hash,pages,color,height,depth,position,added_at) \
             VALUES ('Old','A','pdf','/old.pdf','h',10,'#333333',1.2,0.9,0,1)",
            [],
        )
        .unwrap();
        drop(conn);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lib.sqlite3");
        let mut db = Db {
            conn: Connection::open(&path).unwrap(),
        };
        db.conn.execute_batch(SCHEMA_V1).unwrap();
        db.conn.pragma_update(None, "user_version", 1).unwrap();
        db.conn
            .execute(
                "INSERT INTO books (title,author,format,path,content_hash,pages,color,height,depth,position,added_at) \
                 VALUES ('Old','A','pdf','/old.pdf','h',10,'#333333',1.2,0.9,0,1)",
                [],
            )
            .unwrap();
        db.migrate().unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(db.list_books().unwrap().len(), 1);
        // The new table is usable.
        db.replace_chapters(
            1,
            &[(0, "c1.xhtml".into(), "One".into(), "hello world".into())],
        )
        .unwrap();
        assert_eq!(db.search_chapters(1, "world", 10).unwrap().len(), 1);
    }

    #[test]
    fn books_roundtrip_and_thickness_formula() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "A Wizard of Earthsea", "h1");
        assert_eq!(b.status, Status::Want);
        assert!((b.thickness() - (0.14 + 300.0 * 0.00065)).abs() < 1e-9);

        let updated = db
            .update_book(
                b.id,
                &BookPatch {
                    title: Some("  A Wizard of Earthsea  ".into()),
                    pages: Some(600),
                    status: Some(Status::Reading),
                    color: Some("#123456".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.title, "A Wizard of Earthsea");
        assert_eq!(updated.pages, 600);
        assert_eq!(updated.color, "#123456");
        assert_eq!(db.counts().unwrap().reading, 1);
    }

    #[test]
    fn reorder_moves_book_and_persists_positions() {
        let db = Db::open_in_memory().unwrap();
        let a = sample_book(&db, "A", "ha");
        let b = sample_book(&db, "B", "hb");
        let c = sample_book(&db, "C", "hc");
        db.reorder(c.id, 0).unwrap();
        let titles: Vec<String> = db
            .list_books()
            .unwrap()
            .into_iter()
            .map(|x| x.title)
            .collect();
        assert_eq!(titles, vec!["C", "A", "B"]);
        db.reorder(a.id, 2).unwrap();
        let titles: Vec<String> = db
            .list_books()
            .unwrap()
            .into_iter()
            .map(|x| x.title)
            .collect();
        assert_eq!(titles, vec!["C", "B", "A"]);
        // positions are dense 0..n
        let positions: Vec<i64> = db
            .list_books()
            .unwrap()
            .iter()
            .map(|x| x.position)
            .collect();
        assert_eq!(positions, vec![0, 1, 2]);
        let _ = b;
    }

    #[test]
    fn progress_roundtrip_keeps_typed_locator() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "B", "hb");
        let loc = Locator::Epub {
            spine_index: 3,
            href: "OEBPS/c3.xhtml".into(),
            progress: 0.42,
            text_offset: Some(1200),
            anchor: Some(TextAnchor {
                quote: "the shadow".into(),
                prefix: "in ".into(),
                suffix: " of".into(),
                start: 1200,
                end: 1210,
            }),
        };
        db.save_progress(b.id, &loc, 0.42).unwrap();
        let fresh = db.get_book(b.id).unwrap();
        assert_eq!(fresh.decode_locator().unwrap(), loc);
        assert!((fresh.progress - 0.42).abs() < 1e-6);
        assert!(fresh.last_opened_at.is_some());
    }

    #[test]
    fn annotations_and_bookmarks_crud() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "B", "hb");
        let loc = Locator::Pdf {
            page: 7,
            offset: 0.0,
        };
        let a = db
            .add_annotation(
                b.id,
                &NewAnnotation {
                    locator: loc.clone(),
                    quote: "It is good to have an end".into(),
                    note: String::new(),
                    color: HighlightColor::Blue,
                    page: Some(7),
                },
            )
            .unwrap();
        assert_eq!(a.color, HighlightColor::Blue);
        let patched = db
            .update_annotation(
                a.id,
                &AnnotationPatch {
                    note: Some("important".into()),
                    color: Some(HighlightColor::Pink),
                },
            )
            .unwrap();
        assert_eq!(patched.note, "important");
        assert_eq!(db.list_annotations(b.id).unwrap().len(), 1);

        let bm = db.add_bookmark(b.id, &loc, "", Some(7)).unwrap();
        db.set_bookmark_label(bm.id, "Chapter three").unwrap();
        assert_eq!(db.list_bookmarks(b.id).unwrap()[0].label, "Chapter three");
        db.remove_bookmark(bm.id).unwrap();
        assert!(db.list_bookmarks(b.id).unwrap().is_empty());

        db.delete_book(b.id).unwrap();
        assert!(db.list_annotations(b.id).unwrap().is_empty());
    }

    #[test]
    fn settings_merge_and_persist() {
        let db = Db::open_in_memory().unwrap();
        let mut s = db.load_settings();
        assert_eq!(s.sort, SortKey::Manual);
        s.sort = SortKey::Title;
        s.performance_mode = true;
        s.reader.epub.font_size = 22.0;
        db.save_settings(&s).unwrap();
        let reloaded = db.load_settings();
        assert_eq!(reloaded.sort, SortKey::Title);
        assert!(reloaded.performance_mode);
        assert_eq!(reloaded.reader.epub.font_size, 22.0);
    }

    #[test]
    fn settings_json_with_unknown_fields_falls_back_cleanly() {
        let db = Db::open_in_memory().unwrap();
        db.conn
            .execute(
                "INSERT INTO settings (key, value) VALUES ('settings', ?1)",
                params!["{\"theme\":\"light\",\"unknownFuture\":1}"],
            )
            .unwrap();
        let s = db.load_settings();
        assert_eq!(s.theme, Theme::Light);
        db.conn
            .execute(
                "UPDATE settings SET value = 'not json' WHERE key='settings'",
                [],
            )
            .unwrap();
        assert_eq!(db.load_settings().theme, Theme::System);
    }

    #[test]
    fn chapter_search_is_case_insensitive_and_bounded() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "B", "hb");
        db.replace_chapters(
            b.id,
            &[
                (
                    0,
                    "c1.xhtml".into(),
                    "One".into(),
                    "The Shadow of the Wind".into(),
                ),
                (
                    1,
                    "c2.xhtml".into(),
                    "Two".into(),
                    "Another shadow here".into(),
                ),
            ],
        )
        .unwrap();
        let hits = db.search_chapters(b.id, "shadow", 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].spine_index, 0);
        assert!(hits[0].excerpt.contains("Shadow"));
        assert_eq!(db.search_chapters(b.id, "   ", 10).unwrap().len(), 0);
    }

    #[test]
    fn invalid_color_and_empty_title_are_rejected() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "B", "hb");
        assert!(db
            .update_book(
                b.id,
                &BookPatch {
                    color: Some("blue".into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(db
            .update_book(
                b.id,
                &BookPatch {
                    title: Some("   ".into()),
                    ..Default::default()
                }
            )
            .is_err());
    }

    #[test]
    fn duplicate_hash_lookup_returns_first_match() {
        let db = Db::open_in_memory().unwrap();
        let a = sample_book(&db, "A", "same-hash");
        let _b = sample_book(&db, "B", "same-hash");
        assert_eq!(db.find_by_hash("same-hash").unwrap().unwrap().id, a.id);
        assert!(db.find_by_hash("nope").unwrap().is_none());
    }

    #[test]
    fn sessions_record_seconds() {
        let db = Db::open_in_memory().unwrap();
        let b = sample_book(&db, "B", "hb");
        let id = db.start_session(b.id).unwrap();
        assert!(id > 0);
        db.end_session(b.id).unwrap();
        let ended: Option<i64> = db
            .conn
            .query_row(
                "SELECT ended_at FROM reading_sessions WHERE id=?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ended.is_some());
        // Ending without an open session must not error.
        db.end_session(b.id).unwrap();
    }
}
