// OpenCues TSF text service (TIP) — thin proxy for flash-free text writes.
//
// The spike proved ITfRange::SetText replaces Discord's Slate composer with no
// flash and no ghost (research/tsf-spike.md). This is the production shape: a
// THIN-PROXY TIP that holds no OpenCues logic and is DRIVEN by the WSL daemon
// over a named pipe. Every focused app loads this DLL; the daemon commands the
// focused one to replace text through the input pipeline — the flash-free path.
//
// M1 (this file): the command channel + UI-thread edit marshaling.
//   * Per-process named pipe  \\.\pipe\opencues-tsf-<pid>.
//   * A background pipe thread accepts one command per connection.
//   * TSF edit sessions MUST run on the TIP's UI thread (the app's message
//     thread that owns ITfThreadMgr). The pipe thread can't call them directly,
//     so it hands the command to a MESSAGE-ONLY WINDOW created on the UI thread
//     (PostMessage), and the UI thread's own message loop dispatches it and
//     runs the edit session. Clean, no cross-apartment marshaling.
//   * Command protocol (newline-framed): "SETTEXT\n<utf8 text>" -> replaces the
//     whole focused document; reply "OK hr=0x…\n". Ctrl+Alt+J stays as a manual
//     replace-with-marker fallback.
//
// Build: build-tsf.sh (mingw-w64 from WSL). Install: register-tsf.ps1.
// This whole subtree is a branch spike, revertable to the anchor commit.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <initguid.h>
#include <msctf.h>
#include <olectl.h>
#include <cstdio>
#include <cstring>
#include <cwchar>

// ── Identifiers (spike-local) ───────────────────────────────────────────────
DEFINE_GUID(CLSID_OpenCuesTsf, 0x6e1b4f20, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);
DEFINE_GUID(GUID_OpenCuesProfile, 0x6e1b4f21, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);
DEFINE_GUID(GUID_OpenCuesKey, 0x6e1b4f22, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);
#ifndef GUID_TFCAT_TIPCAP_SECUREMODE
DEFINE_GUID(GUID_TFCAT_TIPCAP_SECUREMODE, 0x49d2f9ce, 0x1f5e, 0x11d7, 0xa6, 0xd3, 0x00, 0x06, 0x5b, 0x84, 0x43, 0x5c);
#endif
#ifndef GUID_TFCAT_TIPCAP_UIELEMENTENABLED
DEFINE_GUID(GUID_TFCAT_TIPCAP_UIELEMENTENABLED, 0x49d2f9cf, 0x1f5e, 0x11d7, 0xa6, 0xd3, 0x00, 0x06, 0x5b, 0x84, 0x43, 0x5c);
#endif

static const WCHAR* kProfileDesc = L"OpenCues TSF";
static const LANGID kLangId = 0x0409;
static const WCHAR* kMarker = L"[OpenCues TSF replaced this text]";

#define WM_OC_SETTEXT (WM_APP + 11)

static HINSTANCE g_hInst = nullptr;
static LONG g_cRefModule = 0;
static void DllAddRef()  { InterlockedIncrement(&g_cRefModule); }
static void DllRelease() { InterlockedDecrement(&g_cRefModule); }

static void Log(const wchar_t* fmt, ...) {
    wchar_t buf[1024];
    va_list ap; va_start(ap, fmt);
    _vsnwprintf(buf, 1023, fmt, ap);
    va_end(ap);
    HANDLE h = CreateFileW(L"\\\\wsl.localhost\\Ubuntu\\tmp\\oc-tsf.log",
                           FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    char utf8[2048];
    int n = WideCharToMultiByte(CP_UTF8, 0, buf, -1, utf8, sizeof(utf8) - 2, nullptr, nullptr);
    if (n > 1) { utf8[n - 1] = '\n'; DWORD w; WriteFile(h, utf8, n, &w, nullptr); }
    CloseHandle(h);
}

// ── Edit session: replace the whole document with a given string ────────────
class CEditSession : public ITfEditSession {
public:
    CEditSession(ITfContext* pCtx, const wchar_t* text)
        : m_cRef(1), m_pCtx(pCtx), m_text(text) { m_pCtx->AddRef(); }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ITfEditSession)) {
            *ppv = (ITfEditSession*)this; AddRef(); return S_OK;
        }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef()  { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() { LONG c = InterlockedDecrement(&m_cRef); if (!c) delete this; return c; }
    STDMETHODIMP DoEditSession(TfEditCookie ec) {
        ITfRange* pRange = nullptr;
        if (FAILED(m_pCtx->GetStart(ec, &pRange)) || !pRange) { m_hr = E_FAIL; return S_OK; }
        LONG shifted = 0;
        pRange->ShiftEnd(ec, 0x7fffffff, &shifted, nullptr);
        m_hr = pRange->SetText(ec, 0, m_text, (LONG)wcslen(m_text));
        ITfRange* pEnd = nullptr;
        if (SUCCEEDED(pRange->Clone(&pEnd)) && pEnd) {
            pEnd->Collapse(ec, TF_ANCHOR_END);
            TF_SELECTION sel; sel.range = pEnd; sel.style.ase = TF_AE_END; sel.style.fInterimChar = FALSE;
            m_pCtx->SetSelection(ec, 1, &sel);
            pEnd->Release();
        }
        pRange->Release();
        return S_OK;
    }
    HRESULT m_hr = S_OK;
private:
    ~CEditSession() { m_pCtx->Release(); }
    LONG m_cRef;
    ITfContext* m_pCtx;
    const wchar_t* m_text;
};

// ── The text service ────────────────────────────────────────────────────────
class CTextService : public ITfTextInputProcessor, public ITfKeyEventSink {
public:
    CTextService() : m_cRef(1), m_pThreadMgr(nullptr), m_tid(0),
                     m_msgWnd(nullptr), m_pipeThread(nullptr), m_stop(nullptr) {
        DllAddRef();
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ITfTextInputProcessor))
            *ppv = (ITfTextInputProcessor*)this;
        else if (IsEqualIID(riid, IID_ITfKeyEventSink))
            *ppv = (ITfKeyEventSink*)this;
        else { *ppv = nullptr; return E_NOINTERFACE; }
        AddRef(); return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef()  { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() { LONG c = InterlockedDecrement(&m_cRef); if (!c) delete this; return c; }

    // ── ITfTextInputProcessor ──
    STDMETHODIMP Activate(ITfThreadMgr* ptim, TfClientId tid) {
        m_pThreadMgr = ptim; m_pThreadMgr->AddRef(); m_tid = tid;
        Log(L"Activate tid=%u pid=%lu", (unsigned)tid, GetCurrentProcessId());

        // Advise the key sink + preserve Ctrl+Alt+J (manual fallback trigger).
        ITfKeystrokeMgr* pKs = nullptr;
        if (SUCCEEDED(m_pThreadMgr->QueryInterface(IID_ITfKeystrokeMgr, (void**)&pKs)) && pKs) {
            pKs->AdviseKeyEventSink(m_tid, (ITfKeyEventSink*)this, TRUE);
            TF_PRESERVEDKEY pk; pk.uVKey = 'J'; pk.uModifiers = TF_MOD_CONTROL | TF_MOD_ALT;
            pKs->PreserveKey(m_tid, GUID_OpenCuesKey, &pk, L"OpenCues replace", 16);
            pKs->Release();
        }

        // Message-only window on THIS (UI) thread — the landing pad for pipe
        // commands, so edit sessions run on the TSF thread.
        WNDCLASSW wc = {};
        wc.lpfnWndProc = WndProcThunk;
        wc.hInstance = g_hInst;
        wc.lpszClassName = L"OpenCuesTsfMsgWnd";
        RegisterClassW(&wc);
        m_msgWnd = CreateWindowExW(0, L"OpenCuesTsfMsgWnd", L"", 0, 0, 0, 0, 0,
                                   HWND_MESSAGE, nullptr, g_hInst, this);

        // Pipe listener thread.
        m_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        m_pipeThread = CreateThread(nullptr, 0, PipeThreadThunk, this, 0, nullptr);
        return S_OK;
    }
    STDMETHODIMP Deactivate() {
        Log(L"Deactivate pid=%lu", GetCurrentProcessId());
        // Stop the pipe thread: signal + self-connect to unblock ConnectNamedPipe.
        if (m_stop) SetEvent(m_stop);
        if (m_pipeThread) {
            wchar_t name[128]; PipeName(name);
            HANDLE dummy = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (dummy != INVALID_HANDLE_VALUE) CloseHandle(dummy);
            WaitForSingleObject(m_pipeThread, 2000);
            CloseHandle(m_pipeThread); m_pipeThread = nullptr;
        }
        if (m_stop) { CloseHandle(m_stop); m_stop = nullptr; }
        if (m_msgWnd) { DestroyWindow(m_msgWnd); m_msgWnd = nullptr; }
        if (m_pThreadMgr) {
            ITfKeystrokeMgr* pKs = nullptr;
            if (SUCCEEDED(m_pThreadMgr->QueryInterface(IID_ITfKeystrokeMgr, (void**)&pKs)) && pKs) {
                TF_PRESERVEDKEY pk; pk.uVKey = 'J'; pk.uModifiers = TF_MOD_CONTROL | TF_MOD_ALT;
                pKs->UnpreserveKey(GUID_OpenCuesKey, &pk);
                pKs->UnadviseKeyEventSink(m_tid);
                pKs->Release();
            }
            m_pThreadMgr->Release(); m_pThreadMgr = nullptr;
        }
        m_tid = 0;
        return S_OK;
    }

    // ── ITfKeyEventSink ──
    STDMETHODIMP OnSetFocus(BOOL) { return S_OK; }
    STDMETHODIMP OnTestKeyDown(ITfContext*, WPARAM, LPARAM, BOOL* e) { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnKeyDown(ITfContext*, WPARAM, LPARAM, BOOL* e)     { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnTestKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* e)   { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* e)       { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnPreservedKey(ITfContext* pContext, REFGUID rguid, BOOL* pfEaten) {
        if (pfEaten) *pfEaten = FALSE;
        if (!IsEqualGUID(rguid, GUID_OpenCuesKey)) return S_OK;
        if (pfEaten) *pfEaten = TRUE;
        Log(L"OnPreservedKey (manual): replacing with marker");
        HRESULT hr = ReplaceFocusedDocument(kMarker);
        Log(L"  manual replace hr=0x%08x", (unsigned)hr);
        return S_OK;
    }

    // Runs on the UI thread. Replace the focused document with `text`.
    HRESULT ReplaceFocusedDocument(const wchar_t* text) {
        if (!m_pThreadMgr) return E_FAIL;
        ITfDocumentMgr* pDim = nullptr;
        if (FAILED(m_pThreadMgr->GetFocus(&pDim)) || !pDim) return E_FAIL;
        ITfContext* pCtx = nullptr;
        HRESULT hr = E_FAIL;
        if (SUCCEEDED(pDim->GetTop(&pCtx)) && pCtx) {
            CEditSession* pes = new CEditSession(pCtx, text);
            HRESULT hrSession = S_OK;
            hr = pCtx->RequestEditSession(m_tid, pes, TF_ES_SYNC | TF_ES_READWRITE, &hrSession);
            if (SUCCEEDED(hr)) hr = pes->m_hr;
            pes->Release();
            pCtx->Release();
        }
        pDim->Release();
        return hr;
    }

private:
    ~CTextService() { if (m_pThreadMgr) m_pThreadMgr->Release(); DllRelease(); }

    void PipeName(wchar_t* out) { swprintf(out, 128, L"\\\\.\\pipe\\opencues-tsf-%lu", GetCurrentProcessId()); }

    // Window proc: WM_OC_SETTEXT carries a heap wchar_t* (lParam) to write; we
    // run the edit session here (UI thread) and stash the HRESULT in a slot the
    // pipe thread reads after its PostMessage returns (SendMessage is sync).
    static LRESULT CALLBACK WndProcThunk(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_NCCREATE) {
            CREATESTRUCTW* cs = (CREATESTRUCTW*)lp;
            SetWindowLongPtrW(h, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
            return DefWindowProcW(h, msg, wp, lp);
        }
        CTextService* self = (CTextService*)GetWindowLongPtrW(h, GWLP_USERDATA);
        if (self && msg == WM_OC_SETTEXT) {
            const wchar_t* text = (const wchar_t*)lp;
            return (LRESULT)self->ReplaceFocusedDocument(text);   // HRESULT back to SendMessage
        }
        return DefWindowProcW(h, msg, wp, lp);
    }

    static DWORD WINAPI PipeThreadThunk(LPVOID p) { return ((CTextService*)p)->PipeThread(); }
    DWORD PipeThread() {
        wchar_t name[128]; PipeName(name);
        Log(L"pipe: listening on %ls", name);
        while (WaitForSingleObject(m_stop, 0) != WAIT_OBJECT_0) {
            HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX,
                                           PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                           PIPE_UNLIMITED_INSTANCES, 1 << 16, 1 << 16, 0, nullptr);
            if (pipe == INVALID_HANDLE_VALUE) { Sleep(200); continue; }
            BOOL ok = ConnectNamedPipe(pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
            if (WaitForSingleObject(m_stop, 0) == WAIT_OBJECT_0) { CloseHandle(pipe); break; }
            if (ok) HandleConnection(pipe);
            CloseHandle(pipe);
        }
        Log(L"pipe: stopped");
        return 0;
    }

    void HandleConnection(HANDLE pipe) {
        // Read until we have a full "OP\n<payload>" (payload may be empty).
        char* buf = (char*)malloc(1 << 16);
        DWORD total = 0, n = 0;
        while (ReadFile(pipe, buf + total, (1 << 16) - 1 - total, &n, nullptr) && n > 0) {
            total += n;
            if (total >= (1 << 16) - 1) break;
            // Byte pipe: assume the client sends one framed message then waits;
            // stop when the write side is drained (client half-closes or we got
            // a newline-terminated header + its declared body). For M1 the
            // client sends everything then reads the reply, so one ReadFile of
            // the whole buffer is typical; loop guards partials.
            DWORD avail = 0;
            if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &avail, nullptr) || avail == 0) break;
        }
        buf[total] = 0;
        HRESULT hr = E_FAIL;
        const char* nl = (const char*)memchr(buf, '\n', total);
        if (nl) {
            size_t opLen = nl - buf;
            if (opLen == 7 && memcmp(buf, "SETTEXT", 7) == 0) {
                const char* payload = nl + 1;
                int wlen = MultiByteToWideChar(CP_UTF8, 0, payload, -1, nullptr, 0);
                wchar_t* wtext = (wchar_t*)malloc((wlen + 1) * sizeof(wchar_t));
                MultiByteToWideChar(CP_UTF8, 0, payload, -1, wtext, wlen);
                Log(L"pipe: SETTEXT %d chars", wlen - 1);
                // Hand to the UI thread synchronously; SendMessage returns the HRESULT.
                if (m_msgWnd) hr = (HRESULT)SendMessageW(m_msgWnd, WM_OC_SETTEXT, 0, (LPARAM)wtext);
                free(wtext);
            }
        }
        char resp[64]; int rl = sprintf(resp, "OK hr=0x%08x\n", (unsigned)hr);
        DWORD w; WriteFile(pipe, resp, rl, &w, nullptr);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        free(buf);
    }

    LONG m_cRef;
    ITfThreadMgr* m_pThreadMgr;
    TfClientId m_tid;
    HWND m_msgWnd;
    HANDLE m_pipeThread;
    HANDLE m_stop;
};

// ── Class factory ───────────────────────────────────────────────────────────
class CClassFactory : public IClassFactory {
public:
    CClassFactory() : m_cRef(1) { DllAddRef(); }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IClassFactory)) {
            *ppv = (IClassFactory*)this; AddRef(); return S_OK;
        }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef()  { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() { LONG c = InterlockedDecrement(&m_cRef); if (!c) delete this; return c; }
    STDMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv) {
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        CTextService* p = new CTextService();
        if (!p) return E_OUTOFMEMORY;
        HRESULT hr = p->QueryInterface(riid, ppv);
        p->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL fLock) { if (fLock) DllAddRef(); else DllRelease(); return S_OK; }
private:
    ~CClassFactory() { DllRelease(); }
    LONG m_cRef;
};

// ── Registry helpers ────────────────────────────────────────────────────────
static bool RegSet(HKEY root, const wchar_t* subkey, const wchar_t* name, const wchar_t* val) {
    HKEY k;
    if (RegCreateKeyExW(root, subkey, 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) != ERROR_SUCCESS) return false;
    LONG r = RegSetValueExW(k, name, 0, REG_SZ, (const BYTE*)val, (DWORD)((wcslen(val) + 1) * sizeof(wchar_t)));
    RegCloseKey(k);
    return r == ERROR_SUCCESS;
}
static void GuidToStr(REFGUID g, wchar_t* out) {
    swprintf(out, 64, L"{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
             g.Data1, g.Data2, g.Data3, g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3],
             g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
}

// ── DLL exports ─────────────────────────────────────────────────────────────
STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
    if (!IsEqualCLSID(rclsid, CLSID_OpenCuesTsf)) return CLASS_E_CLASSNOTAVAILABLE;
    CClassFactory* pf = new CClassFactory();
    if (!pf) return E_OUTOFMEMORY;
    HRESULT hr = pf->QueryInterface(riid, ppv);
    pf->Release();
    return hr;
}
STDAPI DllCanUnloadNow() { return g_cRefModule <= 0 ? S_OK : S_FALSE; }

STDAPI DllRegisterServer() {
    wchar_t clsidStr[64]; GuidToStr(CLSID_OpenCuesTsf, clsidStr);
    wchar_t dllPath[MAX_PATH]; GetModuleFileNameW(g_hInst, dllPath, MAX_PATH);
    wchar_t key[256];
    swprintf(key, 256, L"CLSID\\%ls", clsidStr);
    RegSet(HKEY_CLASSES_ROOT, key, nullptr, kProfileDesc);
    swprintf(key, 256, L"CLSID\\%ls\\InprocServer32", clsidStr);
    RegSet(HKEY_CLASSES_ROOT, key, nullptr, dllPath);
    RegSet(HKEY_CLASSES_ROOT, key, L"ThreadingModel", L"Apartment");

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    ITfInputProcessorProfiles* pProfiles = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_ITfInputProcessorProfiles, (void**)&pProfiles)) && pProfiles) {
        pProfiles->Register(CLSID_OpenCuesTsf);
        pProfiles->AddLanguageProfile(CLSID_OpenCuesTsf, kLangId, GUID_OpenCuesProfile,
                                      kProfileDesc, (ULONG)wcslen(kProfileDesc), nullptr, 0, 0);
        pProfiles->Release();
    }
    ITfCategoryMgr* pCat = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_ITfCategoryMgr, (void**)&pCat)) && pCat) {
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIP_KEYBOARD, CLSID_OpenCuesTsf);
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_UIELEMENTENABLED, CLSID_OpenCuesTsf);
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_SECUREMODE, CLSID_OpenCuesTsf);
        pCat->Release();
    }
    CoUninitialize();
    return S_OK;
}

STDAPI DllUnregisterServer() {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    ITfCategoryMgr* pCat = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_ITfCategoryMgr, (void**)&pCat)) && pCat) {
        pCat->UnregisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIP_KEYBOARD, CLSID_OpenCuesTsf);
        pCat->UnregisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_UIELEMENTENABLED, CLSID_OpenCuesTsf);
        pCat->UnregisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_SECUREMODE, CLSID_OpenCuesTsf);
        pCat->Release();
    }
    ITfInputProcessorProfiles* pProfiles = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_ITfInputProcessorProfiles, (void**)&pProfiles)) && pProfiles) {
        pProfiles->Unregister(CLSID_OpenCuesTsf);
        pProfiles->Release();
    }
    CoUninitialize();
    wchar_t clsidStr[64]; GuidToStr(CLSID_OpenCuesTsf, clsidStr);
    wchar_t key[256];
    swprintf(key, 256, L"CLSID\\%ls\\InprocServer32", clsidStr);
    RegDeleteKeyW(HKEY_CLASSES_ROOT, key);
    swprintf(key, 256, L"CLSID\\%ls", clsidStr);
    RegDeleteKeyW(HKEY_CLASSES_ROOT, key);
    return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { g_hInst = hInst; DisableThreadLibraryCalls(hInst); }
    return TRUE;
}
