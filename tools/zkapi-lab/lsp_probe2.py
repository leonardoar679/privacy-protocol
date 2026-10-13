import ctypes, ctypes.wintypes as w, socket, struct
ws = ctypes.WinDLL("ws2_32", use_last_error=True)
ws.WSASocketW.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, w.DWORD, w.DWORD]; ws.WSASocketW.restype = ctypes.c_size_t
ws.connect.argtypes = [ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int]
ws.closesocket.argtypes = [ctypes.c_size_t]
ip = socket.gethostbyname("proxy.golang.org")
sa = struct.pack("<H", 2) + struct.pack(">H", 443) + socket.inet_aton(ip) + b"\0" * 8
for label, flags in [("WSA_FLAG_OVERLAPPED (python/curl style)", 0x01), ("OVERLAPPED|NO_HANDLE_INHERIT (rust/go style)", 0x81), ("no flags", 0x00)]:
    s = ws.WSASocketW(2, 1, 6, None, 0, flags)
    r = ws.connect(s, sa, len(sa)); err = ws.WSAGetLastError() if r else 0
    print(f"{label}: connect rc={r} err={err}")
    ws.closesocket(s)
