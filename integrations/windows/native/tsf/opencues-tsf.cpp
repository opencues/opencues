// OpenCues TSF spike — a minimal Text Services Framework text service (TIP).
//
// PURPOSE (research spike, NOT production): answer whether a TSF range write
// (ITfRange::SetText, the reconversion-class edit) replaces text in a focused
// Electron app — specifically Discord's Slate editor — WITHOUT the select-all
// flash and WITHOUT the "ghost text" desync that ValuePattern.SetValue causes.
// TSF edits enter through the input pipeline; Chromium converts them into
// trusted composition / insertReplacementText events (ui/base/ime/win/
// tsf_text_store.cc SetText -> select+insert), the same path the OS's own
// autocorrect uses — which does not flash. This DLL proves (or disproves) it.
//
// SHAPE: the absolute minimum TIP.
//   * ITfTextInputProcessor (Activate/Deactivate) + ITfKeyEventSink.
//   * On Activate: advise the key sink and PRESERVE Ctrl+Alt+J.
//   * On that key (which arrives on the TSF UI thread): request a SYNC
//     read/write edit session and replace the WHOLE document with a marker.
//   * Registers keyboard-category (like every IME) so it can be activated and
//     receive the key. The "non-keyboard category to coexist with real IMEs"
//     question is a SEPARATE follow-up — prove the write first.
//
// Build: build-tsf.sh (mingw-w64 cross-compile from WSL). No Visual Studio.
// Install/test/uninstall: register-tsf.ps1 / tsf-probe.ps1 / unregister-tsf.ps1.
// Revert the whole spike: everything is after commit 7dcc0017 on the branch.

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
#include <cwchar>

// ── Our identifiers (spike-local; regenerate for any real product) ──────────
// {6E1B4F20-9C3A-4D7E-8B21-2F5A0C9D1E33} class id of the text service
DEFINE_GUID(CLSID_OpenCuesTsf, 0x6e1b4f20, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);
// {6E1B4F21-...} language profile guid
DEFINE_GUID(GUID_OpenCuesProfile, 0x6e1b4f21, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);
// {6E1B4F22-...} preserved-key guid
DEFINE_GUID(GUID_OpenCuesKey, 0x6e1b4f22, 0x9c3a, 0x4d7e, 0x8b, 0x21, 0x2f, 0x5a, 0x0c, 0x9d, 0x1e, 0x33);

// TSF capability categories absent from GCC 9.3's msctf.h — documented values.
#ifndef GUID_TFCAT_TIPCAP_SECUREMODE
DEFINE_GUID(GUID_TFCAT_TIPCAP_SECUREMODE, 0x49d2f9ce, 0x1f5e, 0x11d7, 0xa6, 0xd3, 0x00, 0x06, 0x5b, 0x84, 0x43, 0x5c);
#endif
#ifndef GUID_TFCAT_TIPCAP_UIELEMENTENABLED
DEFINE_GUID(GUID_TFCAT_TIPCAP_UIELEMENTENABLED, 0x49d2f9cf, 0x1f5e, 0x11d7, 0xa6, 0xd3, 0x00, 0x06, 0x5b, 0x84, 0x43, 0x5c);
#endif

static const WCHAR* kProfileDesc = L"OpenCues TSF (spike)";
static const LANGID kLangId = 0x0409;   // en-US
static const WCHAR* kMarker = L"[OpenCues TSF replaced this text — no flash, no ghost?]";

static HINSTANCE g_hInst = nullptr;
static LONG g_cRefModule = 0;
static void DllAddRef()  { InterlockedIncrement(&g_cRefModule); }
static void DllRelease() { InterlockedDecrement(&g_cRefModule); }

// Log to a WSL-visible file so the spike is diagnosable from the daemon side.
static void Log(const wchar_t* fmt, ...) {
    wchar_t buf[512];
    va_list ap; va_start(ap, fmt);
    _vsnwprintf(buf, 511, fmt, ap);
    va_end(ap);
    HANDLE h = CreateFileW(L"\\\\wsl.localhost\\Ubuntu\\tmp\\oc-tsf.log",
                           FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, nullptr, FILE_END);
    char utf8[1024];
    int n = WideCharToMultiByte(CP_UTF8, 0, buf, -1, utf8, sizeof(utf8) - 2, nullptr, nullptr);
    if (n > 1) { utf8[n - 1] = '\n'; DWORD w; WriteFile(h, utf8, n, &w, nullptr); }
    CloseHandle(h);
}

// ── The edit session: replace the whole document of a context ──────────────
class CEditSession : public ITfEditSession {
public:
    CEditSession(ITfContext* pCtx) : m_cRef(1), m_pCtx(pCtx) { m_pCtx->AddRef(); }
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
        // Whole-document range: a degenerate range at the START, shifted to
        // cover to the END. This is the range the reconversion write targets.
        ITfRange* pRange = nullptr;
        if (FAILED(m_pCtx->GetStart(ec, &pRange)) || !pRange) { Log(L"edit: GetStart failed"); return S_OK; }
        LONG shifted = 0;
        pRange->ShiftEnd(ec, 0x7fffffff, &shifted, nullptr);   // extend end to document end
        HRESULT hr = pRange->SetText(ec, 0, kMarker, (LONG)wcslen(kMarker));
        Log(L"edit: SetText hr=0x%08x shiftedEnd=%d", (unsigned)hr, (int)shifted);
        // Collapse the selection to the end (caret after the replacement).
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
private:
    ~CEditSession() { m_pCtx->Release(); }
    LONG m_cRef;
    ITfContext* m_pCtx;
};

// ── The text service ───────────────────────────────────────────────────────
class CTextService : public ITfTextInputProcessor, public ITfKeyEventSink {
public:
    CTextService() : m_cRef(1), m_pThreadMgr(nullptr), m_tid(0) { DllAddRef(); }

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

    // ITfTextInputProcessor
    STDMETHODIMP Activate(ITfThreadMgr* ptim, TfClientId tid) {
        m_pThreadMgr = ptim; m_pThreadMgr->AddRef(); m_tid = tid;
        Log(L"Activate tid=%u", (unsigned)tid);
        ITfKeystrokeMgr* pKs = nullptr;
        if (SUCCEEDED(m_pThreadMgr->QueryInterface(IID_ITfKeystrokeMgr, (void**)&pKs)) && pKs) {
            pKs->AdviseKeyEventSink(m_tid, (ITfKeyEventSink*)this, TRUE);
            TF_PRESERVEDKEY pk; pk.uVKey = 'J'; pk.uModifiers = TF_MOD_CONTROL | TF_MOD_ALT;
            HRESULT hr = pKs->PreserveKey(m_tid, GUID_OpenCuesKey, &pk, L"OpenCues replace", 16);
            Log(L"PreserveKey Ctrl+Alt+J hr=0x%08x", (unsigned)hr);
            pKs->Release();
        } else Log(L"Activate: no ITfKeystrokeMgr");
        return S_OK;
    }
    STDMETHODIMP Deactivate() {
        Log(L"Deactivate");
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

    // ITfKeyEventSink — pass everything through; only the preserved key acts.
    STDMETHODIMP OnSetFocus(BOOL) { return S_OK; }
    STDMETHODIMP OnTestKeyDown(ITfContext*, WPARAM, LPARAM, BOOL* e) { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnKeyDown(ITfContext*, WPARAM, LPARAM, BOOL* e)     { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnTestKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* e)   { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* e)       { if (e) *e = FALSE; return S_OK; }
    STDMETHODIMP OnPreservedKey(ITfContext* pContext, REFGUID rguid, BOOL* pfEaten) {
        if (pfEaten) *pfEaten = FALSE;
        if (!IsEqualGUID(rguid, GUID_OpenCuesKey)) return S_OK;
        if (pfEaten) *pfEaten = TRUE;
        Log(L"OnPreservedKey: replacing focused document");
        ITfContext* pCtx = pContext; bool ownCtx = false;
        if (!pCtx && m_pThreadMgr) {
            ITfDocumentMgr* pDim = nullptr;
            if (SUCCEEDED(m_pThreadMgr->GetFocus(&pDim)) && pDim) {
                pDim->GetTop(&pCtx); ownCtx = (pCtx != nullptr); pDim->Release();
            }
        }
        if (!pCtx) { Log(L"OnPreservedKey: no context"); return S_OK; }
        CEditSession* pes = new CEditSession(pCtx);
        HRESULT hrSession = S_OK;
        HRESULT hr = pCtx->RequestEditSession(m_tid, pes, TF_ES_SYNC | TF_ES_READWRITE, &hrSession);
        Log(L"RequestEditSession hr=0x%08x sessionHr=0x%08x", (unsigned)hr, (unsigned)hrSession);
        pes->Release();
        if (ownCtx) pCtx->Release();
        return S_OK;
    }
private:
    ~CTextService() { if (m_pThreadMgr) m_pThreadMgr->Release(); DllRelease(); }
    LONG m_cRef;
    ITfThreadMgr* m_pThreadMgr;
    TfClientId m_tid;
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

    // 1. COM in-proc server (HKCR = HKLM\Software\Classes; needs admin).
    wchar_t key[256];
    swprintf(key, 256, L"CLSID\\%ls", clsidStr);
    RegSet(HKEY_CLASSES_ROOT, key, nullptr, kProfileDesc);
    swprintf(key, 256, L"CLSID\\%ls\\InprocServer32", clsidStr);
    RegSet(HKEY_CLASSES_ROOT, key, nullptr, dllPath);
    RegSet(HKEY_CLASSES_ROOT, key, L"ThreadingModel", L"Apartment");

    // 2. TSF registration: profile + keyboard category.
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) { /* may already be init */ }
    ITfInputProcessorProfiles* pProfiles = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_ITfInputProcessorProfiles, (void**)&pProfiles);
    if (SUCCEEDED(hr) && pProfiles) {
        pProfiles->Register(CLSID_OpenCuesTsf);
        pProfiles->AddLanguageProfile(CLSID_OpenCuesTsf, kLangId, GUID_OpenCuesProfile,
                                      kProfileDesc, (ULONG)wcslen(kProfileDesc), nullptr, 0, 0);
        pProfiles->Release();
    }
    ITfCategoryMgr* pCat = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_ITfCategoryMgr, (void**)&pCat)) && pCat) {
        // Keyboard TIP (like every IME) so it can be activated + get the key.
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIP_KEYBOARD, CLSID_OpenCuesTsf);
        // Declared capabilities that let a keyboard TIP behave well.
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_UIELEMENTENABLED, CLSID_OpenCuesTsf);
        pCat->RegisterCategory(CLSID_OpenCuesTsf, GUID_TFCAT_TIPCAP_SECUREMODE, CLSID_OpenCuesTsf);
        pCat->Release();
    }
    CoUninitialize();
    return S_OK;
}

STDAPI DllUnregisterServer() {
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) {}
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
