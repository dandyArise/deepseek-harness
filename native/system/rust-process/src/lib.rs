//! Windows terminal teardown. Identity is checked on the same held handle
//! subsequently terminated, never by PID alone. Existing Jobs are not changed.
#![cfg(windows)]
use std::{
    collections::{HashMap, HashSet},
    mem::{size_of, zeroed},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{Diagnostics::ToolHelp::*, Threading::*},
};
const SYNCHRONIZE: u32 = 0x00100000;

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn last_error() -> u32 {
    unsafe { GetLastError() }
}
fn open(pid: u32, access: u32) -> Result<Handle, u32> {
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        Err(last_error())
    } else {
        Ok(Handle(handle))
    }
}
fn creation(handle: &Handle) -> Result<u64, u32> {
    let (mut c, mut e, mut k, mut u) = unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
    if unsafe { GetProcessTimes(handle.0, &mut c, &mut e, &mut k, &mut u) } == 0 {
        return Err(last_error());
    }
    Ok(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
}
fn active(handle: &Handle) -> Result<bool, u32> {
    match unsafe { WaitForSingleObject(handle.0, 0) } {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        _ => Err(last_error()),
    }
}

#[no_mangle]
pub extern "C" fn dandy_process_abi() -> u32 {
    1
}

/// Output points to three writable u32s: creation high, low, active.
/// Returns 0 on success, Win32 error otherwise. Caller owns output memory.
/// # Safety
/// `output` must address at least 12 writable bytes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn dandy_process_state(pid: u32, output: *mut u32) -> u32 {
    if output.is_null() || pid == 0 {
        return ERROR_INVALID_PARAMETER;
    }
    let result = (|| {
        let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)?;
        let time = creation(&handle)?;
        output.write_unaligned((time >> 32) as u32);
        output.add(1).write_unaligned(time as u32);
        output.add(2).write_unaligned(active(&handle)? as u32);
        Ok::<(), u32>(())
    })();
    result.err().unwrap_or(0)
}

fn table() -> Result<Vec<(u32, u32)>, u32> {
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    let snapshot = Handle(raw);
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return Err(last_error());
    }
    let mut rows = Vec::new();
    loop {
        rows.push((entry.th32ProcessID, entry.th32ParentProcessID));
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            let error = last_error();
            if error != ERROR_NO_MORE_FILES {
                return Err(error);
            }
            break;
        }
    }
    Ok(rows)
}

fn terminate_tree(pid: u32, expected: u64) -> Result<(), u32> {
    if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
        return Err(ERROR_INVALID_PARAMETER);
    }
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE;
    let root = match open(pid, access) {
        Err(ERROR_INVALID_PARAMETER) => return Ok(()), // already gone
        other => other?,
    };
    if creation(&root)? != expected || !active(&root)? {
        return Ok(());
    }
    // Keep every observed handle until cleanup ends, including dead parents:
    // this prevents PID recycling while later snapshots find late descendants.
    let mut members = HashMap::from([(pid, (root, expected))]);
    let mut terminating = HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let rows = table()?;
        let mut changed = false;
        loop {
            let mut added = false;
            for &(child, parent) in &rows {
                if members.contains_key(&child) {
                    continue;
                }
                let Some((_, parent_time)) = members.get(&parent) else {
                    continue;
                };
                let handle = match open(child, access) {
                    Err(ERROR_INVALID_PARAMETER) => continue,
                    Err(error) => {
                        // A process may exit between the snapshot and OpenProcess.
                        // Keep errors for live/unreadable processes; only a signalled
                        // query handle proves that termination is no longer needed.
                        match open(child, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) {
                            Ok(probe) if !active(&probe)? => continue,
                            Err(ERROR_INVALID_PARAMETER) => continue,
                            _ => return Err(error),
                        }
                    }
                    other => other?,
                };
                let time = creation(&handle)?;
                if time < *parent_time || !active(&handle)? {
                    continue;
                }
                members.insert(child, (handle, time));
                added = true;
                changed = true;
            }
            if !added {
                break;
            }
        }
        let mut live = false;
        for (&member_pid, (handle, _)) in &members {
            if !active(handle)? {
                continue;
            }
            live = true;
            if terminating.contains(&member_pid) { continue; }
            if unsafe { TerminateProcess(handle.0, 1) } == 0 {
                let error = last_error();
                if active(handle)? {
                    return Err(error);
                }
            } else {
                // TerminateProcess is asynchronous. Reissuing it while shutdown
                // is pending may return ACCESS_DENIED before the handle signals.
                terminating.insert(member_pid);
            }
        }
        // One additional table observation after termination catches children
        // created during the preceding pass. Failure/timeout stays explicit.
        if !live && !changed {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ERROR_TIMEOUT);
        }
        thread::sleep(Duration::from_millis(1));
    }
}

/// Force-stop only the expected identity and descendants. Nonzero = cleanup
/// could not be proved; never report success or replay a command on failure.
#[no_mangle]
pub extern "C" fn dandy_terminate_tree(pid: u32, high: u32, low: u32) -> u32 {
    terminate_tree(pid, ((high as u64) << 32) | low as u64)
        .err()
        .unwrap_or(0)
}
