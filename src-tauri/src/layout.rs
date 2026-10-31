//! Shelf packing: books fill a case left to right, shelf by shelf. When all
//! four shelves of a case are full a new, identical case is added to its right.
//!
//! A book may also be pinned to a shelf by hand (`LayoutBook::shelf`), which is
//! how dragging a book onto another shelf is remembered. Pinned books claim
//! their shelf first; the rest are packed around them.
//!
//! All measurements are in three.js scene units and mirror the prototype:
//! usable shelf width 7.7 (-3.85 .. 3.85), shelves 1.9 apart, 4 shelves per
//! case, 0.012 gap between books.

use std::collections::BTreeMap;

use crate::models::{ShelfLayout, ShelfSlot};

pub const SHELVES_PER_CASE: u32 = 4;
pub const SHELF_SPACING: f64 = 1.9;
pub const SHELF_BASE_Y: f64 = 0.1;
pub const USABLE_MIN_X: f64 = -3.85;
pub const USABLE_MAX_X: f64 = 3.85;
pub const BOOK_GAP: f64 = 0.012;
pub const USABLE_WIDTH: f64 = USABLE_MAX_X - USABLE_MIN_X;

#[derive(Debug, Clone, Copy)]
pub struct LayoutBook {
    pub id: i64,
    pub thickness: f64,
    pub height: f64,
    pub depth: f64,
    /// Shelf the reader placed this book on (0-based across cases), if any.
    pub shelf: Option<u32>,
}

/// The first shelf, counting up from `start`, with room for `thickness`.
fn fit_shelf(cursors: &BTreeMap<u32, f64>, start: u32, thickness: f64) -> u32 {
    let mut shelf = start;
    loop {
        let cursor = cursors.get(&shelf).copied().unwrap_or(USABLE_MIN_X);
        if cursor + thickness <= USABLE_MAX_X + f64::EPSILON {
            return shelf;
        }
        shelf += 1;
    }
}

pub fn pack(books: &[LayoutBook]) -> ShelfLayout {
    let mut slots: Vec<Option<ShelfSlot>> = vec![None; books.len()];
    let mut cursors: BTreeMap<u32, f64> = BTreeMap::new();
    let mut max_shelf: u32 = 0;

    // Two passes: books placed by hand first, so their shelves are reserved
    // before automatic books start filling from the left.
    for pinned in [true, false] {
        for (index, book) in books.iter().enumerate() {
            if book.shelf.is_some() != pinned {
                continue;
            }
            let thickness = book.thickness.clamp(0.16, 0.55);
            let start = if pinned { book.shelf.unwrap_or(0) } else { 0 };
            let shelf = fit_shelf(&cursors, start, thickness);
            let x = cursors.get(&shelf).copied().unwrap_or(USABLE_MIN_X);
            cursors.insert(shelf, x + thickness + BOOK_GAP);
            max_shelf = max_shelf.max(shelf);
            slots[index] = Some(ShelfSlot {
                book_id: book.id,
                case_index: shelf / SHELVES_PER_CASE,
                shelf_index: shelf % SHELVES_PER_CASE,
                x,
                thickness,
                height: book.height,
                depth: book.depth,
            });
        }
    }

    let slots: Vec<ShelfSlot> = slots.into_iter().flatten().collect();
    let case_count = max_shelf / SHELVES_PER_CASE + 1;
    ShelfLayout { slots, case_count }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(id: i64, thickness: f64) -> LayoutBook {
        LayoutBook {
            id,
            thickness,
            height: 1.3,
            depth: 0.9,
            shelf: None,
        }
    }

    fn pinned(id: i64, thickness: f64, shelf: u32) -> LayoutBook {
        LayoutBook {
            shelf: Some(shelf),
            ..book(id, thickness)
        }
    }

    #[test]
    fn empty_library_still_has_one_case() {
        let layout = pack(&[]);
        assert!(layout.slots.is_empty());
        assert_eq!(layout.case_count, 1);
    }

    #[test]
    fn first_book_starts_at_the_left_edge_of_shelf_zero() {
        let layout = pack(&[book(1, 0.3)]);
        let slot = &layout.slots[0];
        assert_eq!(slot.x, USABLE_MIN_X);
        assert_eq!(slot.shelf_index, 0);
        assert_eq!(slot.case_index, 0);
        assert_eq!(slot.height, 1.3);
        assert_eq!(slot.depth, 0.9);
    }

    #[test]
    fn books_are_separated_by_a_gap() {
        let layout = pack(&[book(1, 0.2), book(2, 0.2)]);
        assert!((layout.slots[1].x - (USABLE_MIN_X + 0.2 + BOOK_GAP)).abs() < 1e-12);
    }

    #[test]
    fn shelf_wraps_when_full() {
        // 0.5-thick books: 15 per shelf (15*0.512 = 7.68), the 16th wraps.
        let books: Vec<_> = (0..16).map(|i| book(i, 0.5)).collect();
        let layout = pack(&books);
        assert_eq!(layout.slots[14].shelf_index, 0);
        assert_eq!(layout.slots[15].shelf_index, 1);
        assert_eq!(layout.slots[15].x, USABLE_MIN_X);
        assert_eq!(layout.slots[15].case_index, 0);
    }

    #[test]
    fn fourth_shelf_overflow_starts_a_new_case() {
        // Fill exactly 4 shelves with 15 books each = 60 books, then one more.
        let mut books: Vec<_> = (0..60).map(|i| book(i, 0.5)).collect();
        books.push(book(60, 0.5));
        let layout = pack(&books);
        let last = layout.slots.last().unwrap();
        assert_eq!(last.case_index, 1);
        assert_eq!(last.shelf_index, 0);
        assert_eq!(last.x, USABLE_MIN_X);
        assert_eq!(layout.case_count, 2);
        assert!(!layout.slots[0..60].iter().any(|s| s.case_index == 1));
    }

    #[test]
    fn every_slot_fits_inside_the_case() {
        // The widest allowed book is 0.55; the narrowest 0.16.
        let books: Vec<_> = (0..500)
            .map(|i| book(i, if i % 3 == 0 { 0.55 } else { 0.16 }))
            .collect();
        let layout = pack(&books);
        for slot in &layout.slots {
            assert!(slot.x >= USABLE_MIN_X - 1e-9);
            assert!(slot.x + slot.thickness <= USABLE_MAX_X + 1e-9);
        }
    }

    #[test]
    fn one_thousand_books_produce_compact_cases() {
        let books: Vec<_> = (0..1000).map(|i| book(i, 0.30)).collect();
        let layout = pack(&books);
        assert_eq!(layout.slots.len(), 1000);
        // 7.7 / 0.312 ~= 24 books per shelf -> 4 shelves = 96 per case.
        let per_case = layout.slots.iter().filter(|s| s.case_index == 0).count();
        assert!((90..=100).contains(&per_case), "per case = {per_case}");
        assert!(layout.case_count >= 10 && layout.case_count <= 12);
        // No duplicate ids and cases increase monotonically.
        let mut last_case = 0;
        for (i, slot) in layout.slots.iter().enumerate() {
            assert_eq!(slot.book_id, i as i64);
            assert!(slot.case_index >= last_case);
            last_case = slot.case_index;
        }
    }

    #[test]
    fn oversized_thickness_is_clamped() {
        let layout = pack(&[book(1, 5.0), book(2, 0.01)]);
        assert_eq!(layout.slots[0].thickness, 0.55);
        assert_eq!(layout.slots[1].thickness, 0.16);
    }

    #[test]
    fn a_pinned_book_keeps_its_shelf() {
        let layout = pack(&[book(1, 0.3), pinned(2, 0.3, 2), book(3, 0.3)]);
        assert_eq!(layout.slots[1].shelf_index, 2);
        assert_eq!(layout.slots[1].case_index, 0);
        // Automatic books fill the shelves before it.
        assert_eq!(layout.slots[0].shelf_index, 0);
        assert_eq!(layout.slots[2].shelf_index, 0);
        assert_eq!(layout.case_count, 1);
    }

    #[test]
    fn a_pinned_book_can_open_a_new_case() {
        let layout = pack(&[book(1, 0.3), pinned(2, 0.3, 5)]);
        assert_eq!(layout.slots[1].case_index, 1);
        assert_eq!(layout.slots[1].shelf_index, 1);
        assert_eq!(layout.case_count, 2);
    }

    #[test]
    fn pinned_books_share_a_shelf_in_reading_order() {
        let layout = pack(&[pinned(1, 0.3, 1), pinned(2, 0.3, 1)]);
        assert_eq!(layout.slots[0].shelf_index, 1);
        assert_eq!(layout.slots[1].shelf_index, 1);
        assert!(layout.slots[1].x > layout.slots[0].x);
    }

    #[test]
    fn a_full_pinned_shelf_overflows_to_the_next_one() {
        let mut books: Vec<_> = (0..15).map(|i| pinned(i, 0.5, 2)).collect();
        books.push(pinned(99, 0.5, 2));
        let layout = pack(&books);
        let last = layout.slots.last().unwrap();
        assert_eq!(last.shelf_index, 3);
        assert_eq!(last.x, USABLE_MIN_X);
    }
}
