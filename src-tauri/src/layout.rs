//! Shelf packing: books fill a case left to right, shelf by shelf. When all
//! four shelves of a case are full a new, identical case is added to its right.
//!
//! All measurements are in three.js scene units and mirror the prototype:
//! usable shelf width 7.7 (-3.85 .. 3.85), shelves 1.9 apart, 4 shelves per
//! case, 0.012 gap between books.

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
}

pub fn pack(books: &[LayoutBook]) -> ShelfLayout {
    let mut slots = Vec::with_capacity(books.len());
    let mut case_index: u32 = 0;
    let mut shelf_index: u32 = 0;
    let mut cursor = USABLE_MIN_X;

    for book in books {
        let thickness = book.thickness.clamp(0.16, 0.55);
        // Leave room for the gap after every book, so a book never touches the
        // side panel.
        if cursor + thickness > USABLE_MAX_X + f64::EPSILON {
            shelf_index += 1;
            cursor = USABLE_MIN_X;
            if shelf_index >= SHELVES_PER_CASE {
                shelf_index = 0;
                case_index += 1;
            }
        }
        slots.push(ShelfSlot {
            book_id: book.id,
            case_index,
            shelf_index,
            x: cursor,
            thickness,
            height: book.height,
            depth: book.depth,
        });
        cursor += thickness + BOOK_GAP;
    }

    let case_count = case_index + 1;
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
}
