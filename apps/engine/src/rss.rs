//! Resident set size of this process: implemented in the projections crate (shared with the tail
//! loop's RSS-aware eviction); re-exported here for the health endpoint.
pub use blackbox_projections::mem::rss;
