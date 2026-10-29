// Shown by the crash catcher in app/layout.tsx when the app can't start (a browser too old for it, like iOS 13 Safari).
// Plain ES5 on purpose. If this browser holds an old Burner key, it shows the key as an xdai.io/pk# link QR: scan it
// with a newer phone and the sweep runs there (docs/XDAI.md). The key never leaves this page.
(function () {
  if (document.getElementById("iw-crash")) return;
  var errs = window.__iwErrs || [];

  function burnerKey() {
    var raw = "";
    try { raw = localStorage.getItem("metaPrivateKey") || ""; } catch (e) {}
    if (!raw) {
      var m = document.cookie.match(/(?:^|; )metaPrivateKey=([^;]*)/);
      if (m) raw = decodeURIComponent(m[1]);
    }
    var k = raw.replace(/"/g, "").replace(/^0x/i, "");
    return /^[0-9a-f]{64}$/i.test(k) ? "0x" + k.toLowerCase() : null;
  }

  var d = document.createElement("div");
  d.id = "iw-crash";
  d.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;padding:24px;background:#121212;color:#eee;" +
    "font:17px/1.45 -apple-system,sans-serif;overflow:auto;z-index:99999;text-align:center";
  var key = burnerKey();
  d.innerHTML =
    "<p style='font-size:20px;font-weight:700;margin:12px 0'>This phone's browser is too old for the new wallet.</p>" +
    (key
      ? "<p>Your old wallet is still here and safe.</p>" +
        "<p>To move it: on a newer phone, open the Camera and scan the code below. The money moves there.</p>" +
        "<button id=iw-show style='font:inherit;font-weight:700;padding:14px 22px;border:0;border-radius:12px;" +
        "background:#fff;color:#121212;margin:8px 0'>Show code</button>" +
        "<div id=iw-qr style='margin:16px auto'></div>" +
        "<p style='font-size:14px;color:#aaa'>The code is your old wallet's key. Don't show it to anyone else.</p>"
      : "<p>Open xdai.io on a newer phone or a computer.</p>") +
    "<pre style='white-space:pre-wrap;text-align:left;font-size:11px;color:#888;margin-top:32px'></pre>";
  d.querySelector("pre").textContent = (errs.length ? errs.join("\n") : "no error caught") + "\n\n" + navigator.userAgent;
  document.body.appendChild(d);

  var btn = document.getElementById("iw-show");
  if (btn) btn.onclick = function () {
    btn.style.display = "none";
    var s = document.createElement("script");
    s.src = "/old/qrcode.js";
    s.onload = function () {
      var q = qrcode(0, "M");
      q.addData("https://xdai.io/pk#" + key);
      q.make();
      var box = document.getElementById("iw-qr");
      box.style.cssText = "margin:16px auto;background:#fff;padding:16px;border-radius:12px;display:inline-block";
      box.innerHTML = q.createImgTag(6, 0);
    };
    document.head.appendChild(s);
  };
})();
