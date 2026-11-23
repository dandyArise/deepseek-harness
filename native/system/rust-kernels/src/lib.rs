//! Pure kernels: no filesystem, credentials or execution privileges.
#[no_mangle]
pub extern "C" fn kernel_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Callers must pass a live allocation with its original length, exactly once.
#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}

/// Same arithmetic as the TS policy, without model/provider-specific rules.
#[no_mangle]
pub extern "C" fn pressure_threshold(
    window: f64,
    reserved: f64,
    ratio: f64,
    headroom: f64,
    fixed: u32,
) -> f64 {
    let available = window - reserved;
    let reserve = if fixed != 0 {
        headroom
    } else {
        headroom.min((available / 4.0).floor())
    };
    (window * ratio).min(available - reserve).floor()
}

fn scan(
    input: &[u8],
    max_frames: usize,
    mut frame: impl FnMut(usize, usize),
) -> Result<(usize, Option<usize>), (i32, usize)> {
    let mut offset = 0usize;
    let mut count = 0;
    while offset < input.len() {
        let start = offset;
        macro_rules! need {
            ($n:expr) => {
                if input.len() - offset < $n {
                    return Ok((count, Some(start)));
                }
            };
        }
        need!(4);
        if input[offset..offset + 4] != [0x28, 0xb5, 0x2f, 0xfd] {
            return Err((-1, offset));
        }
        offset += 4;
        need!(1);
        let descriptor = input[offset];
        offset += 1;
        if descriptor & 0x18 != 0 {
            return Err((-2, offset - 1));
        }
        let single = descriptor & 0x20 != 0;
        let size_flag = descriptor >> 6;
        let dict_flag = descriptor & 3;
        let dict_bytes = if dict_flag == 3 {
            4
        } else {
            dict_flag as usize
        };
        let content_bytes = if size_flag == 0 {
            usize::from(single)
        } else {
            1 << size_flag
        };
        let header = usize::from(!single) + dict_bytes + content_bytes;
        need!(header);
        offset += header;
        loop {
            need!(3);
            let block = input[offset] as usize
                | (input[offset + 1] as usize) << 8
                | (input[offset + 2] as usize) << 16;
            offset += 3;
            let kind = (block >> 1) & 3;
            if kind == 3 {
                return Err((-3, offset - 3));
            }
            let bytes = if kind == 1 { 1 } else { block >> 3 };
            need!(bytes);
            offset += bytes;
            if block & 1 != 0 {
                break;
            }
        }
        if descriptor & 4 != 0 {
            need!(4);
            offset += 4;
        }
        frame(start, offset);
        count += 1;
        if count == max_frames {
            return Ok((count, None));
        }
    }
    Ok((count, None))
}

/// Output: torn-start or MAX, error-offset, then start/end pairs.
/// Buffers must be allocated by this module; output needs 2 + 2*(len/8+1) u32s.
#[no_mangle]
pub unsafe extern "C" fn scan_frames(
    ptr: *const u8,
    len: usize,
    output: *mut u32,
    max_frames: u32,
) -> i32 {
    let input = std::slice::from_raw_parts(ptr, len);
    let mut index = 2;
    match scan(input, max_frames as usize, |start, end| {
        output.add(index).write_unaligned(start as u32);
        output.add(index + 1).write_unaligned(end as u32);
        index += 2;
    }) {
        Ok((count, torn)) => {
            output.write_unaligned(torn.map_or(u32::MAX, |x| x as u32));
            count as i32
        }
        Err((code, offset)) => {
            output.add(1).write_unaligned(offset as u32);
            code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_reserves_reply_and_scaled_headroom() {
        assert_eq!(pressure_threshold(8192., 2048., 0.8, 65536., 0), 4608.);
        assert_eq!(pressure_threshold(32768., 2048., 0.8, 65536., 0), 23040.);
    }
    #[test]
    fn complete_and_torn_empty_frames() {
        let frame = [0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 1, 0, 0];
        for cut in 1..frame.len() {
            assert_eq!(scan(&frame[..cut], 10, |_, _| {}), Ok((0, Some(0))));
        }
        assert_eq!(
            scan(&frame, 10, |s, e| assert_eq!((s, e), (0, 9))),
            Ok((1, None))
        );
        assert_eq!(scan(&[1, 2, 3, 4], 10, |_, _| {}), Err((-1, 0)));
    }
}
