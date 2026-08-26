/**
 * Host half — boot paint + ops product defaults (welcome ack, workspace-write).
 */
export const name = "ops-skin";

/** Keep in sync with @deepseek-ai/dsh-client-ui-settings-models onboarding-copy. */
var WELCOME_NOTICE_VERSION = "2026-08-13.1";
var WELCOME_NOTICE_NS = "ui-onboarding";
var PERMISSION_NS = "permission";
var PERMISSION_DEFAULT = "workspace-write";

var BOOT_STYLE_ID = "dsh-ops-skin-boot";

function injectBootPaint(html) {
  var style =
    "<style id=\"" + BOOT_STYLE_ID + "\">" +
    "html,body,#root{height:100%;margin:0;background:#07151c!important;color-scheme:dark}" +
    "</style>";
  var script =
    "<script>(()=>{" +
    "document.documentElement.style.colorScheme='dark';" +
    "document.body&&document.body.setAttribute('data-ds-dark-theme','');" +
    "try{" +
    "var k='dsh.workspace.view.v5';" +
    "var next={groupBy:'flat',orderBy:'updated',groupExpansion:{},sessionOrderByAccount:{},sessionUpdatedAtByAccount:{}};" +
    "var raw=localStorage.getItem(k);" +
    "if(raw){try{var p=JSON.parse(raw);if(p&&typeof p==='object')next=Object.assign({},p,{groupBy:'flat'});}catch(e){}}" +
    "localStorage.setItem(k,JSON.stringify(next));" +
    "}catch(e){}" +
    "})()</script>";

  if (html.indexOf("id=\"" + BOOT_STYLE_ID + "\"") < 0) {
    var head = /<\/head>/i.exec(html);
    if (head !== null) {
      html = html.slice(0, head.index) + style + html.slice(head.index);
    } else {
      html = style + html;
    }
  }

  var body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body === null) return html + script;
  var insertAt = body.index + body[0].length;
  return html.slice(0, insertAt) + script + html.slice(insertAt);
}

function warn(ctx, label, err) {
  var msg = err && err.message ? err.message : String(err);
  if (ctx.logger && ctx.logger.warn) ctx.logger.warn("[ops-skin] " + label + ": " + msg);
  else console.warn("[ops-skin] " + label + ":", msg);
}

function ackWelcomeNotice(ctx) {
  var settings = ctx.settings;
  if (settings === undefined) return;
  try {
    var current = settings.get(WELCOME_NOTICE_NS);
    var version =
      current && typeof current === "object" ? current.welcomeNoticeVersion : undefined;
    if (version === WELCOME_NOTICE_VERSION) return;
    void settings
      .update(WELCOME_NOTICE_NS, { welcomeNoticeVersion: WELCOME_NOTICE_VERSION })
      .catch(function (err) { warn(ctx, "welcome ack failed", err); });
  } catch (err) {
    warn(ctx, "welcome ack failed", err);
  }
}

function lockWorkspaceWrite(ctx) {
  var settings = ctx.settings;
  if (settings === undefined) return;
  try {
    var current = settings.get(PERMISSION_NS);
    var preset =
      current && typeof current === "object" ? current.defaultPreset : undefined;
    if (preset === PERMISSION_DEFAULT) return;
    void settings
      .update(PERMISSION_NS, { defaultPreset: PERMISSION_DEFAULT })
      .catch(function (err) { warn(ctx, "permission default failed", err); });
  } catch (err) {
    warn(ctx, "permission default failed", err);
  }
}

export function apply(ctx) {
  ctx.inject(["webServer"], function (httpCtx) {
    httpCtx.effect(
      function () {
        return httpCtx.webServer.tapIndex(injectBootPaint);
      },
      "ops-skin: boot paint",
    );
  });

  ctx.inject(["settings"], function (settingsCtx) {
    ackWelcomeNotice(settingsCtx);
    lockWorkspaceWrite(settingsCtx);
  });
}
