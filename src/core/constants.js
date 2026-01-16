// Core constants and configuration
// Exported via window.GameConstants to avoid global scope pollution
if (typeof window !== 'undefined') {
    // Keep the in-game debug HUD ON by default (upper-left),
    // but keep browser console logging OFF by default to avoid FPS drops from console spam.
    //
    // Overrides:
    // - HUD: `?hud=0` (or `?perf=1`) to disable the HUD entirely
    // - Console logs: `?logs=1` to enable console log/info/debug/warn
    // - Damage logs (selective): `?dmglog=1`
    //
    // localStorage overrides:
    // - `hud=0/1`, `logs=0/1`, `dmglog=0/1`
    let hud = true;
    let logs = false;
    let dmglog = false;
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (params.get('perf') === '1') hud = false;
        if (params.has('hud')) hud = (params.get('hud') === '1' || params.get('hud') === 'true');
        if (params.has('logs')) logs = (params.get('logs') === '1' || params.get('logs') === 'true');
        if (params.has('dmglog')) dmglog = (params.get('dmglog') === '1' || params.get('dmglog') === 'true');

        if (window.localStorage && window.localStorage.getItem('hud') != null) {
            hud = (window.localStorage.getItem('hud') === '1');
        }
        if (window.localStorage && window.localStorage.getItem('logs') != null) {
            logs = (window.localStorage.getItem('logs') === '1');
        }
        if (window.localStorage && window.localStorage.getItem('dmglog') != null) {
            dmglog = (window.localStorage.getItem('dmglog') === '1');
        }
    } catch (_) {}

    // Also expose a legacy flag some modules already check
    window.DEBUG_BUILD = !!hud;

    window.GameConstants = {
        DEBUG: !!hud,
        ENABLE_DEBUG_LOGS: !!logs,
        ENABLE_DAMAGE_LOGS: !!dmglog
    };
}
