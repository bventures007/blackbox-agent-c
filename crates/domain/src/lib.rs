//! Blackbox domain: pure deterministic reducers and views over the five-track journal.
//! No I/O. See docs/engine.md.

pub mod entry;
pub mod fixture;
pub mod reducer;
pub mod state;
pub mod views;

/// Reducer version persisted in checkpoints/snapshots. Bump when any rule changes.
pub const REDUCER_VERSION: u32 = 1;

pub use entry::{Entry, EntrySummary, Track};
pub use reducer::{apply, Outcome};
pub use state::{Kind, Rec, RecKey, Sym, TenantState};
