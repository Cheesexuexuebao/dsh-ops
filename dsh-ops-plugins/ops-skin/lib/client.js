/**
 * dsh-ops-skin — browser half.
 * Cyan tech skin for 运维智能体: force one palette, restyle tokens,
 * hide the entire Appearance settings block, suppress welcome notice, load IBM Plex fonts.
 */
window.__ModuleLoader__.load({
  id: "dsh-ops-skin",
  factory: function () {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var CSS_ATTR = "data-dsh-ops-skin-css";
    var FONT_ATTR = "data-dsh-ops-skin-font";

    var VOID = "#07151C";
    var PANEL = "#0C2430";
    var PANEL2 = "#0F2E3C";
    var PANEL3 = "#143A4A";
    var LINE = "#1A4A5C";
    var CYAN = "#2EE6D6";
    var CYAN_DIM = "#14999A";
    var INK = "#E6F7F5";
    var MUTE = "#7AA8AD";
    var MUTE2 = "#5A858C";

    function same(value) {
      return { light: value, dark: value };
    }

    function tokenOverrides() {
      return {
        "--dsw-alias-bg-base": same(VOID),
        "--dsw-alias-bg-layer-1": same(PANEL),
        "--dsw-alias-bg-layer-2": same(PANEL2),
        "--dsw-alias-bg-layer-3": same(PANEL3),
        "--dsw-alias-bg-module-platform": same(PANEL2),
        "--dsw-alias-bg-overlay": same(PANEL3),
        "--dsw-alias-bg-multi-select": same(PANEL2),
        "--dsw-alias-bg-skeleton": same("rgba(46, 230, 214, 0.08)"),
        "--dsw-alias-border-l1": same("rgba(46, 230, 214, 0.08)"),
        "--dsw-alias-border-l2": same("rgba(46, 230, 214, 0.16)"),
        "--dsw-alias-border-l3": same("rgba(46, 230, 214, 0.22)"),
        "--dsw-alias-border-l4": same("rgba(46, 230, 214, 0.28)"),
        "--dsw-alias-brand-primary": same(CYAN),
        "--dsw-alias-brand-primary-invert": same(VOID),
        "--dsw-alias-brand-text": same(INK),
        "--dsw-alias-brand-primary-new-colorprimary-new-color": same(CYAN),
        "--dsw-alias-label-primary": same(INK),
        "--dsw-alias-label-secondary": same(MUTE),
        "--dsw-alias-label-tertiary": same(MUTE2),
        "--dsw-alias-label-caption": same(MUTE2),
        "--dsw-alias-label-primary-inverted": same(VOID),
        "--dsw-alias-label-primary-foreground": same(VOID),
        "--dsw-alias-label-primary-dimmed": same(INK),
        "--dsw-alias-label-primary-bluish": same(CYAN),
        "--dsw-alias-label-dimmed": same(PANEL3),
        "--dsw-alias-button-primary-fill": same(CYAN),
        "--dsw-alias-button-primary-hover": same(CYAN_DIM),
        "--dsw-alias-button-primary-dimmed": same(PANEL3),
        "--dsw-alias-button-info-fill": same(CYAN_DIM),
        "--dsw-alias-button-info-hover": same(CYAN),
        "--dsw-alias-button-elevated-fill": same(PANEL2),
        "--dsw-alias-button-floating-fill": same(PANEL),
        "--dsw-alias-button-floating-hover": same(PANEL2),
        "--dsw-alias-button-contrast-fill": same(MUTE),
        "--dsw-alias-interactive-bg-hover": same("rgba(46, 230, 214, 0.08)"),
        "--dsw-alias-interactive-bg-hover-accent": same("rgba(46, 230, 214, 0.16)"),
        "--dsw-alias-interactive-bg-active": same("rgba(46, 230, 214, 0.2)"),
        "--dsw-alias-interactive-bg-hover-solid": same(PANEL2),
        "--dsw-alias-state-business-primary": same(CYAN),
        "--dsw-alias-state-business-tertiary": same("rgba(46, 230, 214, 0.12)"),
        "--dsw-alias-scrollbar-bg-l1": same(LINE),
        "--dsw-alias-scrollbar-bg-l2": same(CYAN_DIM),
        "--dsw-alias-scrollbar-hover-l1": same(CYAN_DIM),
        "--dsw-alias-scrollbar-hover-l2": same(CYAN),
        "--dsw-alias-toast-bg": same(PANEL3),
        "--dsw-alias-tooltip-bg": same(PANEL3),
        "--dsw-alias-markdown-code-block": same(PANEL),
        "--dsw-alias-markdown-code-block-banner": same(PANEL2),
        "--dsw-alias-markdown-inline-code": same(PANEL2),
        "--dsw-alias-markdown-placeholder": same(PANEL2),
        "--dsw-specific-sidebar-fill": same(PANEL),
        "--dsw-specific-sidebar-nav-item-hover": same("rgba(46, 230, 214, 0.08)"),
        "--dsw-specific-sidebar-nav-item-active": same("rgba(46, 230, 214, 0.14)"),
        "--dsw-specific-sidebar-nav-item-active-accent": same("rgba(46, 230, 214, 0.22)"),
        "--dsw-specific-bubble": same(PANEL2),
        "--dsw-specific-bubble-highlight": same("rgba(46, 230, 214, 0.18)"),
        "--dsw-specific-input-major": same(PANEL),
        "--dsw-specific-menu": same(PANEL2),
        "--dsw-specific-selector": same(PANEL2),
        "--dsw-specific-tip": same(PANEL2),
      };
    }

    function ensureFonts() {
      if (typeof document === "undefined") return;
      if (document.querySelector("[" + FONT_ATTR + "]")) return;
      var link = document.createElement("link");
      link.setAttribute(FONT_ATTR, "1");
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    }

    function ensureCss() {
      if (typeof document === "undefined") return;
      var style = document.querySelector("[" + CSS_ATTR + "]");
      if (!style) {
        style = document.createElement("style");
        style.setAttribute(CSS_ATTR, "1");
        document.head.appendChild(style);
      }
      style.textContent = [
        "html, body {",
        "  color-scheme: dark !important;",
        "  font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif !important;",
        "}",
        "body, body[data-ds-dark-theme] {",
        "  --dsw-alias-bg-base: " + VOID + " !important;",
        "  --dsw-alias-bg-layer-1: " + PANEL + " !important;",
        "  --dsw-alias-bg-layer-2: " + PANEL2 + " !important;",
        "  --dsw-alias-bg-layer-3: " + PANEL3 + " !important;",
        "  --dsw-alias-bg-module-platform: " + PANEL2 + " !important;",
        "  --dsw-alias-bg-overlay: " + PANEL3 + " !important;",
        "  --dsw-alias-brand-primary: " + CYAN + " !important;",
        "  --dsw-alias-brand-text: " + INK + " !important;",
        "  --dsw-alias-label-primary: " + INK + " !important;",
        "  --dsw-alias-label-secondary: " + MUTE + " !important;",
        "  --dsw-alias-label-tertiary: " + MUTE2 + " !important;",
        "  --dsw-alias-label-caption: " + MUTE2 + " !important;",
        "  --dsw-alias-border-l1: rgba(46, 230, 214, 0.08) !important;",
        "  --dsw-alias-border-l2: rgba(46, 230, 214, 0.16) !important;",
        "  --dsw-alias-border-l3: rgba(46, 230, 214, 0.22) !important;",
        "  --dsw-specific-sidebar-fill: " + PANEL + " !important;",
        "  --dsw-specific-bubble: " + PANEL2 + " !important;",
        "  --dsw-specific-input-major: " + PANEL + " !important;",
        "  --dsw-alias-button-primary-fill: " + CYAN + " !important;",
        "  --dsw-alias-button-primary-hover: " + CYAN_DIM + " !important;",
        "  --dsw-alias-state-business-primary: " + CYAN + " !important;",
        "  background-color: " + VOID + " !important;",
        "  color: " + INK + " !important;",
        "}",
        "code, pre, kbd, samp, .mono, [data-slot*='code'] {",
        "  font-family: 'IBM Plex Mono', ui-monospace, monospace !important;",
        "}",
        ":focus-visible {",
        "  outline: 2px solid " + CYAN + " !important;",
        "  outline-offset: 2px;",
        "}",
        "/* Hide entire Appearance section (title + cubes) */",
        "[data-dsh-ops-skin-hide-appearance='1'] { display: none !important; }",
        "/* Ops product: suppress DSH internal-testing welcome notice */",
        "[data-dsh-ops-skin-hide-welcome='1'] { display: none !important; }",
        "/* Lock sidebar view options (group-by / sort) */",
        "button[aria-label='视图选项'],",
        "button[aria-label='View options'] { display: none !important; }",
        "/* Hide composer command (+) launcher */",
        "button[aria-label='命令'],",
        "button[aria-label='Commands'] { display: none !important; }",
        "/* Lock permission / access mode changers */",
        "button[aria-label^='访问模式'],",
        "button[aria-label^='Access mode'] { display: none !important; }",
        "[data-dsh-ops-skin-hide-permission='1'] { display: none !important; }",
        "/* Soft cyan glow on empty hero if present */",
        "[class*='HeroGlow'], [class*='heroGlow'] {",
        "  background: radial-gradient(ellipse at center, rgba(46,230,214,0.18), transparent 70%) !important;",
        "}",
        "/* Selection */",
        "::selection { background: rgba(46, 230, 214, 0.28); color: " + INK + "; }",
      ].join("\n");
    }

    function isAppearanceTitle(text) {
      var t = (text || "").trim();
      return t === "外观" || t === "Appearance";
    }

    function hasThemeCubes(el) {
      if (!el || !el.querySelectorAll) return false;
      var labels = ["Light", "Dark", "System", "浅色", "深色", "跟随系统"];
      var buttons = el.querySelectorAll("button");
      var hit = 0;
      for (var i = 0; i < buttons.length; i++) {
        var t = (buttons[i].textContent || "").trim();
        if (labels.indexOf(t) >= 0) hit += 1;
      }
      return hit >= 3;
    }

    /**
     * Hide the whole Appearance block (title「外观」+ Light/Dark/System cubes),
     * not only the cubes. Climb from the title node to the nearest ancestor
     * that contains the three theme buttons.
     */
    function markAppearanceRows() {
      if (typeof document === "undefined") return;
      var candidates = document.querySelectorAll("div, span, p, h1, h2, h3, h4, label");
      for (var i = 0; i < candidates.length; i++) {
        var titleEl = candidates[i];
        // Prefer leaf-ish title nodes: exact text, no nested element text noise.
        if (!isAppearanceTitle(titleEl.textContent || "")) continue;
        if (titleEl.children && titleEl.children.length > 0) {
          // Title wrapper with a single text child is OK; skip if it embeds the cubes.
          if (hasThemeCubes(titleEl)) continue;
        }
        var el = titleEl;
        while (el && el !== document.body && el !== document.documentElement) {
          if (el.getAttribute && el.getAttribute("data-dsh-ops-skin-hide-appearance") === "1") break;
          if (hasThemeCubes(el)) {
            el.setAttribute("data-dsh-ops-skin-hide-appearance", "1");
            break;
          }
          el = el.parentElement;
        }
      }
    }

    function watchAppearance() {
      markAppearanceRows();
      if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
        return function () {};
      }
      var observer = new MutationObserver(function () {
        markAppearanceRows();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return function () {
        observer.disconnect();
      };
    }

    function lockDarkAttr() {
      if (typeof document === "undefined") return;
      document.body.setAttribute("data-ds-dark-theme", "");
      document.documentElement.style.colorScheme = "dark";
    }

    var VIEW_PERSIST_KEY = "dsh.workspace.view.v5";
    var FLAT_RELOAD_FLAG = "dsh-ops-skin-flat-reloaded";

    /** Force sidebar session list to flat (单列表); reload once if storage changed. */
    function forceFlatGroupBy() {
      if (typeof localStorage === "undefined") return;
      var next = {
        groupBy: "flat",
        orderBy: "updated",
        groupExpansion: {},
        sessionOrderByAccount: {},
        sessionUpdatedAtByAccount: {},
      };
      var changed = true;
      try {
        var raw = localStorage.getItem(VIEW_PERSIST_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            if (parsed.groupBy === "flat") changed = false;
            next = Object.assign({}, parsed, { groupBy: "flat" });
          }
        }
        localStorage.setItem(VIEW_PERSIST_KEY, JSON.stringify(next));
      } catch (_) {
        return;
      }
      if (!changed) return;
      if (typeof sessionStorage === "undefined") return;
      try {
        if (sessionStorage.getItem(FLAT_RELOAD_FLAG) === "1") return;
        sessionStorage.setItem(FLAT_RELOAD_FLAG, "1");
        location.reload();
      } catch (_) {}
    }

    function isPermissionTitle(text) {
      var t = (text || "").trim();
      return t === "权限" || t === "Permission";
    }

    /** Hide settings General 「权限」row if the ui-permission plugin is still present. */
    function markPermissionRows() {
      if (typeof document === "undefined") return;
      var nodes = document.querySelectorAll("div, section, li, article");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.getAttribute("data-dsh-ops-skin-hide-permission") === "1") continue;
        var direct = el.children;
        var hasTitle = false;
        for (var c = 0; c < direct.length; c++) {
          var childText = (direct[c].textContent || "").trim();
          var first = childText.split("\n")[0].trim();
          if (isPermissionTitle(childText) || isPermissionTitle(first)) {
            hasTitle = true;
            break;
          }
        }
        if (!hasTitle) continue;
        var body = (el.textContent || "");
        if (
          body.indexOf("默认权限") < 0 &&
          body.indexOf("default permission") < 0 &&
          body.indexOf("Workspace") < 0 &&
          body.indexOf("工作区") < 0 &&
          body.indexOf("read-only") < 0 &&
          body.indexOf("只读") < 0
        ) {
          continue;
        }
        el.setAttribute("data-dsh-ops-skin-hide-permission", "1");
      }
    }

    function isWelcomeTitle(text) {
      var t = (text || "").trim();
      return t === "内测声明" || t === "Internal Testing Notice";
    }

    function isWelcomeContinue(text) {
      var t = (text || "").trim();
      return t === "继续" || t === "Continue";
    }

    /**
     * Hide + auto-ack the DSH welcome notice (blocks onboarding; remote
     * browsers cannot persist Host settings and would re-show it).
     */
    function dismissWelcomeNotice() {
      if (typeof document === "undefined") return;
      var headings = document.querySelectorAll("h1, h2, h3, [role='heading']");
      for (var i = 0; i < headings.length; i++) {
        var titleEl = headings[i];
        if (!isWelcomeTitle(titleEl.textContent || "")) continue;
        var dialog =
          titleEl.closest("[role='dialog']") ||
          titleEl.closest("[class*='Modal']") ||
          titleEl.closest("[class*='dialog']") ||
          titleEl.parentElement;
        if (!dialog) continue;
        if (dialog.getAttribute("data-dsh-ops-skin-hide-welcome") !== "1") {
          dialog.setAttribute("data-dsh-ops-skin-hide-welcome", "1");
        }
        var buttons = dialog.querySelectorAll("button");
        for (var b = 0; b < buttons.length; b++) {
          if (!isWelcomeContinue(buttons[b].textContent || "")) continue;
          if (buttons[b].getAttribute("data-dsh-ops-skin-welcome-clicked") === "1") break;
          buttons[b].setAttribute("data-dsh-ops-skin-welcome-clicked", "1");
          try {
            buttons[b].click();
          } catch (_) {}
          break;
        }
        var root = document.getElementById("root");
        if (root && root.inert) root.inert = false;
      }
    }

    function watchWelcomeNotice() {
      dismissWelcomeNotice();
      markPermissionRows();
      if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
        return function () {};
      }
      var observer = new MutationObserver(function () {
        dismissWelcomeNotice();
        markPermissionRows();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return function () {
        observer.disconnect();
      };
    }

    var name = "ops-skin";
    var inject = ["theme"];

    function apply(ctx) {
      forceFlatGroupBy();
      ensureFonts();
      ensureCss();
      lockDarkAttr();
      var stopWatch = watchAppearance();
      var stopWelcome = watchWelcomeNotice();

      var theme = ctx.theme;
      var disposeTokens = null;
      if (theme && typeof theme.overrideTokens === "function") {
        try {
          disposeTokens = theme.overrideTokens("dsh-ops-skin", tokenOverrides());
        } catch (err) {
          console.warn("[ops-skin] overrideTokens failed:", err && err.message ? err.message : err);
        }
      }
      if (theme && typeof theme.setTheme === "function") {
        try {
          theme.setTheme("dark");
        } catch (err) {
          console.warn("[ops-skin] setTheme failed:", err && err.message ? err.message : err);
        }
      }

      var onChange = function () {
        lockDarkAttr();
        ensureCss();
      };
      if (ctx.on) ctx.on("theme/change", onChange);

      return function () {
        stopWatch();
        stopWelcome();
        if (disposeTokens) disposeTokens();
        if (ctx.off) ctx.off("theme/change", onChange);
      };
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return exports;
  },
});
