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
#include <cstdlib>
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

#define WM_OC_CMD (WM_APP + 11)

// A command marshaled from the pipe thread onto the UI thread. The UI thread
// fills out* / hr and signals completion (SendMessage is synchronous).
enum OcOp { OP_SETTEXT, OP_GETTEXT, OP_GETCARET, OP_SETCARET };
struct OcCmd {
    OcOp op;
    const wchar_t* inText;   // SETTEXT: text to write
    LONG inNum;              // SETCARET: offset (-1 = end)
    wchar_t* outText;        // GETTEXT: heap result (caller frees)
    LONG outNum;             // GETCARET: caret offset
    HRESULT hr;
    OcCmd() : op(OP_GETTEXT), inText(nullptr), inNum(-1), outText(nullptr), outNum(-1), hr(E_FAIL) {}
};

static HINSTANCE g_hInst = nullptr;
static LONG g_cRefModule = 0;
static void DllAddRef()  { InterlockedIncrement(&g_cRefModule); }
static void DllRelease() { InterlockedDecrement(&g_cRefModule); }

// ── Event push channel (M3) ─────────────────────────────────────────────────
// A subscriber (the daemon) sends SUBSCRIBE and the TIP holds that pipe open,
// streaming events to it: "<TYPE>:<byteLen>\n<utf8 bytes>" frames (length-
// prefixed so text with newlines is safe). Written from the UI thread (the TSF
// sinks) under a lock; a failed write means the subscriber dropped -> clear.
static CRITICAL_SECTION g_evtLock;
static HANDLE g_evtPipe = INVALID_HANDLE_VALUE;
static void PushEvent(const char* type, const wchar_t* body) {
    EnterCriticalSection(&g_evtLock);
    if (g_evtPipe != INVALID_HANDLE_VALUE) {
        int u8 = body ? WideCharToMultiByte(CP_UTF8, 0, body, -1, nullptr, 0, nullptr, nullptr) : 1;
        int bytes = (u8 > 0) ? u8 - 1 : 0;   // exclude the terminating NUL
        char hdr[64]; int hl = sprintf(hdr, "%s:%d\n", type, bytes);
        DWORD w; BOOL ok = WriteFile(g_evtPipe, hdr, hl, &w, nullptr);
        if (ok && bytes > 0) {
            char* b = (char*)malloc(bytes + 1);
            WideCharToMultiByte(CP_UTF8, 0, body, -1, b, bytes + 1, nullptr, nullptr);
            ok = WriteFile(g_evtPipe, b, bytes, &w, nullptr);
            free(b);
        }
        if (ok) FlushFileBuffers(g_evtPipe);
        else { CloseHandle(g_evtPipe); g_evtPipe = INVALID_HANDLE_VALUE; }
    }
    LeaveCriticalSection(&g_evtLock);
}

// Read the whole document at a read cookie into a heap buffer (caller frees).
static HRESULT ReadWholeText(ITfContext* ctx, TfEditCookie ec, wchar_t** out) {
    *out = nullptr;
    ITfRange* r = nullptr;
    if (FAILED(ctx->GetStart(ec, &r)) || !r) return E_FAIL;
    LONG sh = 0; r->ShiftEnd(ec, 0x7fffffff, &sh, nullptr);
    const ULONG cap = 1 << 16;
    wchar_t* buf = (wchar_t*)malloc(cap * sizeof(wchar_t));
    ULONG total = 0;
    while (total < cap - 1) {
        ULONG got = 0;
        HRESULT g = r->GetText(ec, TF_TF_MOVESTART, buf + total, cap - 1 - total, &got);
        if (FAILED(g) || got == 0) break;
        total += got;
    }
    buf[total] = 0;
    *out = buf;
    r->Release();
    return S_OK;
}

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

// ── Edit session: runs one OcCmd against the focused context ────────────────
class CEditSession : public ITfEditSession {
public:
    CEditSession(ITfContext* pCtx, OcCmd* cmd)
        : m_cRef(1), m_pCtx(pCtx), m_cmd(cmd) { m_pCtx->AddRef(); }
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
        switch (m_cmd->op) {
            case OP_SETTEXT:  m_cmd->hr = DoSetText(ec);  break;
            case OP_GETTEXT:  m_cmd->hr = DoGetText(ec);  break;
            case OP_GETCARET: m_cmd->hr = DoGetCaret(ec); break;
            case OP_SETCARET: m_cmd->hr = DoSetCaret(ec); break;
        }
        return S_OK;
    }
private:
    ~CEditSession() { m_pCtx->Release(); }

    // Whole-document range: degenerate at start, shifted to cover to the end.
    HRESULT WholeRange(TfEditCookie ec, ITfRange** pp) {
        *pp = nullptr;
        ITfRange* r = nullptr;
        if (FAILED(m_pCtx->GetStart(ec, &r)) || !r) return E_FAIL;
        LONG shifted = 0;
        r->ShiftEnd(ec, 0x7fffffff, &shifted, nullptr);
        *pp = r;
        return S_OK;
    }

    HRESULT DoSetText(TfEditCookie ec) {
        ITfRange* r = nullptr;
        HRESULT hr = WholeRange(ec, &r);
        if (FAILED(hr) || !r) return hr;
        hr = r->SetText(ec, 0, m_cmd->inText, (LONG)wcslen(m_cmd->inText));
        ITfRange* e = nullptr;
        if (SUCCEEDED(r->Clone(&e)) && e) {
            e->Collapse(ec, TF_ANCHOR_END);
            TF_SELECTION sel; sel.range = e; sel.style.ase = TF_AE_END; sel.style.fInterimChar = FALSE;
            m_pCtx->SetSelection(ec, 1, &sel);
            e->Release();
        }
        r->Release();
        return hr;
    }

    HRESULT DoGetText(TfEditCookie ec) {
        return ReadWholeText(m_pCtx, ec, &m_cmd->outText);   // caller frees outText
    }

    HRESULT DoGetCaret(TfEditCookie ec) {
        TF_SELECTION sel; ULONG fetched = 0;
        HRESULT hr = m_pCtx->GetSelection(ec, TF_DEFAULT_SELECTION, 1, &sel, &fetched);
        if (FAILED(hr) || fetched == 0 || !sel.range) { m_cmd->outNum = -1; return hr; }
        LONG off = -1;
        ITfRangeACP* acp = nullptr;
        if (SUCCEEDED(sel.range->QueryInterface(IID_ITfRangeACP, (void**)&acp)) && acp) {
            LONG anchor = 0, cch = 0;
            if (SUCCEEDED(acp->GetExtent(&anchor, &cch))) off = anchor;   // selection start / caret
            acp->Release();
        }
        sel.range->Release();
        m_cmd->outNum = off;
        return S_OK;
    }

    HRESULT DoSetCaret(TfEditCookie ec) {
        ITfRange* r = nullptr;
        if (FAILED(m_pCtx->GetStart(ec, &r)) || !r) return E_FAIL;
        LONG shifted = 0;
        if (m_cmd->inNum < 0) r->ShiftEnd(ec, 0x7fffffff, &shifted, nullptr);   // END
        else                  r->ShiftEnd(ec, m_cmd->inNum, &shifted, nullptr); // offset N
        r->Collapse(ec, TF_ANCHOR_END);
        TF_SELECTION sel; sel.range = r; sel.style.ase = TF_AE_END; sel.style.fInterimChar = FALSE;
        HRESULT hr = m_pCtx->SetSelection(ec, 1, &sel);
        r->Release();
        return hr;
    }

    LONG m_cRef;
    ITfContext* m_pCtx;
    OcCmd* m_cmd;
};

// ── The text service ────────────────────────────────────────────────────────
class CTextService : public ITfTextInputProcessor, public ITfKeyEventSink,
                     public ITfThreadMgrEventSink, public ITfTextEditSink {
public:
    CTextService() : m_cRef(1), m_pThreadMgr(nullptr), m_tid(0),
                     m_msgWnd(nullptr), m_pipeThread(nullptr), m_stop(nullptr),
                     m_dwThreadMgrCookie(TF_INVALID_COOKIE),
                     m_pEditCtx(nullptr), m_dwEditCookie(TF_INVALID_COOKIE) {
        DllAddRef();
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_ITfTextInputProcessor))
            *ppv = static_cast<ITfTextInputProcessor*>(this);
        else if (IsEqualIID(riid, IID_ITfKeyEventSink))
            *ppv = static_cast<ITfKeyEventSink*>(this);
        else if (IsEqualIID(riid, IID_ITfThreadMgrEventSink))
            *ppv = static_cast<ITfThreadMgrEventSink*>(this);
        else if (IsEqualIID(riid, IID_ITfTextEditSink))
            *ppv = static_cast<ITfTextEditSink*>(this);
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

        // Advise the thread-manager event sink (focus changes -> we (re)advise
        // the text-edit sink on the focused context, and push FOCUS events).
        ITfSource* pSrc = nullptr;
        if (SUCCEEDED(m_pThreadMgr->QueryInterface(IID_ITfSource, (void**)&pSrc)) && pSrc) {
            pSrc->AdviseSink(IID_ITfThreadMgrEventSink,
                             static_cast<ITfThreadMgrEventSink*>(this), &m_dwThreadMgrCookie);
            pSrc->Release();
        }
        // Advise the text-edit sink on whatever's already focused.
        ITfDocumentMgr* pDim = nullptr;
        if (SUCCEEDED(m_pThreadMgr->GetFocus(&pDim)) && pDim) { AdviseEditSink(pDim); pDim->Release(); }

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
        UnadviseEditSink();
        if (m_pThreadMgr && m_dwThreadMgrCookie != TF_INVALID_COOKIE) {
            ITfSource* pSrc = nullptr;
            if (SUCCEEDED(m_pThreadMgr->QueryInterface(IID_ITfSource, (void**)&pSrc)) && pSrc) {
                pSrc->UnadviseSink(m_dwThreadMgrCookie);
                pSrc->Release();
            }
            m_dwThreadMgrCookie = TF_INVALID_COOKIE;
        }
        // Drop any event subscriber owned by this process.
        EnterCriticalSection(&g_evtLock);
        if (g_evtPipe != INVALID_HANDLE_VALUE) { CloseHandle(g_evtPipe); g_evtPipe = INVALID_HANDLE_VALUE; }
        LeaveCriticalSection(&g_evtLock);
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
        OcCmd c; c.op = OP_SETTEXT; c.inText = kMarker;
        RunCommand(&c);
        Log(L"  manual replace hr=0x%08x", (unsigned)c.hr);
        return S_OK;
    }

    // ── ITfThreadMgrEventSink ── focus moves between documents/apps.
    STDMETHODIMP OnInitDocumentMgr(ITfDocumentMgr*) { return S_OK; }
    STDMETHODIMP OnUninitDocumentMgr(ITfDocumentMgr*) { return S_OK; }
    STDMETHODIMP OnSetFocus(ITfDocumentMgr* pdimFocus, ITfDocumentMgr* /*pdimPrev*/) {
        UnadviseEditSink();
        if (pdimFocus) AdviseEditSink(pdimFocus);
        PushEvent("FOCUS", nullptr);
        return S_OK;
    }
    STDMETHODIMP OnPushContext(ITfContext*) { return S_OK; }
    STDMETHODIMP OnPopContext(ITfContext*) { return S_OK; }

    // ── ITfTextEditSink ── fires after every edit to the watched context.
    STDMETHODIMP OnEndEdit(ITfContext* pic, TfEditCookie ecReadOnly, ITfEditRecord* /*pRec*/) {
        wchar_t* text = nullptr;
        if (SUCCEEDED(ReadWholeText(pic, ecReadOnly, &text)) && text) {
            PushEvent("TEXTCHANGED", text);
            free(text);
        }
        return S_OK;
    }

    void AdviseEditSink(ITfDocumentMgr* pdim) {
        ITfContext* pCtx = nullptr;
        if (FAILED(pdim->GetTop(&pCtx)) || !pCtx) return;
        ITfSource* pSrc = nullptr;
        if (SUCCEEDED(pCtx->QueryInterface(IID_ITfSource, (void**)&pSrc)) && pSrc) {
            if (SUCCEEDED(pSrc->AdviseSink(IID_ITfTextEditSink,
                          static_cast<ITfTextEditSink*>(this), &m_dwEditCookie))) {
                m_pEditCtx = pCtx; m_pEditCtx->AddRef();
            }
            pSrc->Release();
        }
        pCtx->Release();
    }
    void UnadviseEditSink() {
        if (m_pEditCtx && m_dwEditCookie != TF_INVALID_COOKIE) {
            ITfSource* pSrc = nullptr;
            if (SUCCEEDED(m_pEditCtx->QueryInterface(IID_ITfSource, (void**)&pSrc)) && pSrc) {
                pSrc->UnadviseSink(m_dwEditCookie);
                pSrc->Release();
            }
        }
        if (m_pEditCtx) { m_pEditCtx->Release(); m_pEditCtx = nullptr; }
        m_dwEditCookie = TF_INVALID_COOKIE;
    }

    // Runs on the UI thread. Executes one command against the focused context.
    HRESULT RunCommand(OcCmd* cmd) {
        if (!m_pThreadMgr) return (cmd->hr = E_FAIL);
        ITfDocumentMgr* pDim = nullptr;
        if (FAILED(m_pThreadMgr->GetFocus(&pDim)) || !pDim) return (cmd->hr = E_FAIL);
        ITfContext* pCtx = nullptr;
        HRESULT hr = E_FAIL;
        if (SUCCEEDED(pDim->GetTop(&pCtx)) && pCtx) {
            bool write = (cmd->op == OP_SETTEXT || cmd->op == OP_SETCARET);
            DWORD flags = TF_ES_SYNC | (write ? TF_ES_READWRITE : TF_ES_READ);
            CEditSession* pes = new CEditSession(pCtx, cmd);
            HRESULT hrSession = S_OK;
            hr = pCtx->RequestEditSession(m_tid, pes, flags, &hrSession);
            if (FAILED(hr)) cmd->hr = hr;              // request itself failed
            else if (FAILED(hrSession)) cmd->hr = hrSession;  // session couldn't be granted
            pes->Release();
            pCtx->Release();
        } else cmd->hr = E_FAIL;
        pDim->Release();
        return cmd->hr;
    }

private:
    ~CTextService() { if (m_pThreadMgr) m_pThreadMgr->Release(); DllRelease(); }

    void PipeName(wchar_t* out) { swprintf(out, 128, L"\\\\.\\pipe\\opencues-tsf-%lu", GetCurrentProcessId()); }

    // Window proc: WM_OC_CMD carries an OcCmd* (lParam); we run it here (UI
    // thread, where edit sessions must run) and the pipe thread reads the
    // filled struct after its synchronous SendMessage returns.
    static LRESULT CALLBACK WndProcThunk(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_NCCREATE) {
            CREATESTRUCTW* cs = (CREATESTRUCTW*)lp;
            SetWindowLongPtrW(h, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
            return DefWindowProcW(h, msg, wp, lp);
        }
        CTextService* self = (CTextService*)GetWindowLongPtrW(h, GWLP_USERDATA);
        if (self && msg == WM_OC_CMD) {
            self->RunCommand((OcCmd*)lp);
            return 0;
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
            bool keepOpen = false;
            if (ok) keepOpen = HandleConnection(pipe);
            if (!keepOpen) CloseHandle(pipe);   // SUBSCRIBE transfers ownership to g_evtPipe
        }
        Log(L"pipe: stopped");
        return 0;
    }

    // Returns true if the pipe was transferred (kept open) — SUBSCRIBE.
    bool HandleConnection(HANDLE pipe) {
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
        // Parse "OP\n<payload>". Ops: SETTEXT (payload=text), GETTEXT,
        // GETCARET, SETCARET (payload=offset decimal, or "end").
        const char* nl = (const char*)memchr(buf, '\n', total);
        size_t opLen = nl ? (size_t)(nl - buf) : total;
        const char* payload = nl ? nl + 1 : "";
        OcCmd cmd;
        bool known = true;
        wchar_t* wtext = nullptr;
        if (opLen == 7 && memcmp(buf, "SETTEXT", 7) == 0) {
            cmd.op = OP_SETTEXT;
            int wlen = MultiByteToWideChar(CP_UTF8, 0, payload, -1, nullptr, 0);
            wtext = (wchar_t*)malloc((wlen + 1) * sizeof(wchar_t));
            MultiByteToWideChar(CP_UTF8, 0, payload, -1, wtext, wlen);
            cmd.inText = wtext;
            Log(L"pipe: SETTEXT %d chars", wlen - 1);
        } else if (opLen == 7 && memcmp(buf, "GETTEXT", 7) == 0) {
            cmd.op = OP_GETTEXT;
        } else if (opLen == 8 && memcmp(buf, "GETCARET", 8) == 0) {
            cmd.op = OP_GETCARET;
        } else if (opLen == 8 && memcmp(buf, "SETCARET", 8) == 0) {
            cmd.op = OP_SETCARET;
            cmd.inNum = (payload[0] == 'e' || payload[0] == 'E') ? -1 : atol(payload);
        } else if (opLen == 9 && memcmp(buf, "SUBSCRIBE", 9) == 0) {
            // Long-lived event stream: reply OK, transfer the pipe to g_evtPipe,
            // keep it open. The UI-thread sinks write events to it.
            const char* okmsg = "OK subscribed\n";
            DWORD w; WriteFile(pipe, okmsg, (DWORD)strlen(okmsg), &w, nullptr); FlushFileBuffers(pipe);
            EnterCriticalSection(&g_evtLock);
            if (g_evtPipe != INVALID_HANDLE_VALUE) CloseHandle(g_evtPipe);   // replace prior subscriber
            g_evtPipe = pipe;
            LeaveCriticalSection(&g_evtLock);
            Log(L"pipe: SUBSCRIBE — streaming events");
            free(buf);
            return true;   // keepOpen
        } else {
            known = false;
        }

        char* resp = nullptr; int rl = 0;
        if (!known) {
            resp = (char*)malloc(32); rl = sprintf(resp, "ERR unknown op\n");
        } else {
            if (m_msgWnd) SendMessageW(m_msgWnd, WM_OC_CMD, 0, (LPARAM)&cmd);   // sync, runs on UI thread
            if (cmd.op == OP_GETTEXT && SUCCEEDED(cmd.hr) && cmd.outText) {
                int u8 = WideCharToMultiByte(CP_UTF8, 0, cmd.outText, -1, nullptr, 0, nullptr, nullptr);
                resp = (char*)malloc(u8 + 32);
                int hn = sprintf(resp, "OK len=%d\n", u8 - 1);
                int wn = WideCharToMultiByte(CP_UTF8, 0, cmd.outText, -1, resp + hn, u8, nullptr, nullptr);
                rl = hn + (wn > 0 ? wn - 1 : 0);   // drop the trailing NUL from the wire
            } else if (cmd.op == OP_GETCARET && SUCCEEDED(cmd.hr)) {
                resp = (char*)malloc(48); rl = sprintf(resp, "OK caret=%ld\n", cmd.outNum);
            } else {
                resp = (char*)malloc(48); rl = sprintf(resp, "OK hr=0x%08x\n", (unsigned)cmd.hr);
            }
        }
        DWORD w; WriteFile(pipe, resp, rl, &w, nullptr);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        if (cmd.outText) free(cmd.outText);
        if (wtext) free(wtext);
        if (resp) free(resp);
        free(buf);
        return false;   // one-shot command connection; PipeThread closes it
    }

    LONG m_cRef;
    ITfThreadMgr* m_pThreadMgr;
    TfClientId m_tid;
    HWND m_msgWnd;
    HANDLE m_pipeThread;
    HANDLE m_stop;
    DWORD m_dwThreadMgrCookie;   // ITfThreadMgrEventSink advise cookie
    ITfContext* m_pEditCtx;      // context the text-edit sink is advised on
    DWORD m_dwEditCookie;        // ITfTextEditSink advise cookie
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
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
        InitializeCriticalSection(&g_evtLock);
    } else if (reason == DLL_PROCESS_DETACH) {
        DeleteCriticalSection(&g_evtLock);
    }
    return TRUE;
}
