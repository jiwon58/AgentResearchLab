use std::{ffi::c_void, ptr};

type Handle = *mut c_void;
type BrowseCallback = unsafe extern "system" fn(Handle, u32, isize, isize) -> i32;

#[repr(C)]
struct BrowseInfo {
    owner: Handle,
    root: *const c_void,
    display_name: *mut u16,
    title: *const u16,
    flags: u32,
    callback: Option<BrowseCallback>,
    data: isize,
    image: i32,
}

#[link(name = "shell32")]
extern "system" {
    fn SHBrowseForFolderW(info: *const BrowseInfo) -> *mut c_void;
    fn SHGetPathFromIDListEx(item: *const c_void, path: *mut u16, capacity: u32, flags: u32)
        -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *const c_void, flags: u32) -> i32;
    fn CoTaskMemFree(memory: *mut c_void);
    fn CoUninitialize();
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(
        window: Handle,
        insert_after: Handle,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn SetForegroundWindow(window: Handle) -> i32;
}

unsafe extern "system" fn on_browse(window: Handle, message: u32, _: isize, _: isize) -> i32 {
    const BFFM_INITIALIZED: u32 = 1;
    const SHOW_IN_PLACE: u32 = 0x0043;
    if message == BFFM_INITIALIZED {
        SetWindowPos(window, ptr::null_mut(), 0, 0, 0, 0, SHOW_IN_PLACE);
        SetForegroundWindow(window);
    }
    0
}

pub fn choose_folder() -> Result<Option<String>, ()> {
    const COINIT_APARTMENTTHREADED: u32 = 2;
    const BIF_RETURNONLYFSDIRS: u32 = 1;
    const BIF_EDITBOX: u32 = 16;
    const BIF_NEWDIALOGSTYLE: u32 = 64;
    let title: Vec<u16> = "Gajae Research Lab - Select a working folder\0"
        .encode_utf16()
        .collect();
    let mut display = [0u16; 260];
    let mut path = vec![0u16; 32_768];
    let info = BrowseInfo {
        owner: ptr::null_mut(),
        root: ptr::null(),
        display_name: display.as_mut_ptr(),
        title: title.as_ptr(),
        flags: BIF_RETURNONLYFSDIRS | BIF_EDITBOX | BIF_NEWDIALOGSTYLE,
        callback: Some(on_browse),
        data: 0,
        image: 0,
    };
    // Both buffers and the title live throughout the modal call. Shell-allocated memory
    // and the thread's COM initialization are released before interpreting the result.
    let found = unsafe {
        if CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED) < 0 {
            return Err(());
        }
        let item = SHBrowseForFolderW(&info);
        let found = if item.is_null() {
            None
        } else {
            let status = SHGetPathFromIDListEx(item, path.as_mut_ptr(), path.len() as u32, 0);
            CoTaskMemFree(item);
            Some(status != 0)
        };
        CoUninitialize();
        found
    };
    match found {
        None => Ok(None),
        Some(false) => Err(()),
        Some(true) => {
            let end = path.iter().position(|unit| *unit == 0).ok_or(())?;
            String::from_utf16(&path[..end]).map(Some).map_err(|_| ())
        }
    }
}
