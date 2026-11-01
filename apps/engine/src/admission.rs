//! Admission control: bounded concurrency per process (32), per workspace/tenant (16) and per
//! agent principal (8, header X-Principal-Id). Overload is an explicit `overloaded` error with
//! retry_after_ms; nothing queues unboundedly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

pub struct Admission {
    global: Arc<Semaphore>,
    per_tenant: Mutex<HashMap<Uuid, Arc<Semaphore>>>,
    per_agent: Mutex<HashMap<String, Arc<Semaphore>>>,
    pub limits: Limits,
    pub rejected: std::sync::atomic::AtomicU64,
    pub admitted: std::sync::atomic::AtomicU64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub global: usize,
    pub per_workspace: usize,
    pub per_agent: usize,
}

pub struct Permits {
    _g: OwnedSemaphorePermit,
    _t: OwnedSemaphorePermit,
    _a: Option<OwnedSemaphorePermit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    Global,
    Workspace,
    Agent,
}

impl Admission {
    pub fn new(limits: Limits) -> Admission {
        Admission {
            global: Arc::new(Semaphore::new(limits.global)),
            per_tenant: Mutex::new(HashMap::new()),
            per_agent: Mutex::new(HashMap::new()),
            limits,
            rejected: std::sync::atomic::AtomicU64::new(0),
            admitted: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn tenant_sem(&self, tenant: Uuid) -> Arc<Semaphore> {
        let mut m = self.per_tenant.lock().unwrap();
        m.entry(tenant)
            .or_insert_with(|| Arc::new(Semaphore::new(self.limits.per_workspace)))
            .clone()
    }

    fn agent_sem(&self, agent: &str) -> Arc<Semaphore> {
        let mut m = self.per_agent.lock().unwrap();
        if m.len() > 10_000 {
            m.retain(|_, s| s.available_permits() < self.limits.per_agent);
        }
        m.entry(agent.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(self.limits.per_agent)))
            .clone()
    }

    /// Non-blocking admission: either all permits are taken or the request is rejected.
    pub fn try_admit(&self, tenant: Uuid, agent: Option<&str>) -> Result<Permits, Rejected> {
        let g = self.global.clone().try_acquire_owned().map_err(|_| Rejected::Global)?;
        let t = self
            .tenant_sem(tenant)
            .try_acquire_owned()
            .map_err(|_| Rejected::Workspace)?;
        let a = match agent {
            Some(id) if !id.is_empty() => Some(
                self.agent_sem(id)
                    .try_acquire_owned()
                    .map_err(|_| Rejected::Agent)?,
            ),
            _ => None,
        };
        self.admitted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(Permits { _g: g, _t: t, _a: a })
    }

    pub fn in_flight_global(&self) -> usize {
        self.limits.global - self.global.available_permits()
    }
}
