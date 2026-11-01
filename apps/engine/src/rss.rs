//! Resident set size of this process: /proc/self/statm on Linux, proc_pidinfo on macOS,
//! otherwise 0 with a note.

pub struct Rss {
    pub bytes: u64,
    pub note: &'static str,
}

#[cfg(target_os = "linux")]
pub fn rss() -> Rss {
    match std::fs::read_to_string("/proc/self/statm") {
        Ok(s) => {
            let pages: u64 = s.split_whitespace().nth(1).and_then(|p| p.parse().ok()).unwrap_or(0);
            let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
            Rss {
                bytes: pages * page,
                note: "linux:/proc/self/statm",
            }
        }
        Err(_) => Rss {
            bytes: 0,
            note: "linux:/proc/self/statm unavailable",
        },
    }
}

#[cfg(target_os = "macos")]
pub fn rss() -> Rss {
    use std::mem::MaybeUninit;
    let pid = unsafe { libc::getpid() };
    let mut info = MaybeUninit::<libc::proc_taskinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr() as *mut libc::c_void,
            size,
        )
    };
    if n == size {
        let info = unsafe { info.assume_init() };
        Rss {
            bytes: info.pti_resident_size,
            note: "macos:proc_pidinfo(PROC_PIDTASKINFO)",
        }
    } else {
        Rss {
            bytes: 0,
            note: "macos:proc_pidinfo failed",
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn rss() -> Rss {
    Rss {
        bytes: 0,
        note: "rss not available on this platform",
    }
}
