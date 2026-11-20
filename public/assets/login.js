'use strict';

// Chrome and other browsers may restore the login page from the back/forward
// cache without contacting PHP. Reload a restored login page so the server can
// redirect an already-authenticated session back to the application.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
