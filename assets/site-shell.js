(function () {
  "use strict";

  var header = document.querySelector(".site-header");
  if (!header) return;

  var mobile = window.matchMedia("(max-width: 740px)");
  var queued = false;

  function updateHeader() {
    var compact = header.classList.contains("is-compact");

    if (!mobile.matches) compact = false;
    else if (!compact && window.scrollY > 120) compact = true;
    else if (compact && window.scrollY < 20) compact = false;

    header.classList.toggle("is-compact", compact);
    queued = false;
  }

  function queueUpdate() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(updateHeader);
  }

  window.addEventListener("scroll", queueUpdate, { passive: true });
  window.addEventListener("resize", queueUpdate);
  if (typeof mobile.addEventListener === "function") mobile.addEventListener("change", queueUpdate);
  updateHeader();
}());
