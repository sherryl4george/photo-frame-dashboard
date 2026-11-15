# Third-party code

`app/` is a trimmed copy of the dashboard front end from
https://github.com/sambartle/photo-frame-dashboard (`dashboard/`, commit `875b675`), itself a fork of
https://github.com/wesbos/photo-frame-dashboard. Both are MIT licensed (Copyright (c) 2026 Wes Bos).
Removed: the phone upload and mobile pages, the share-target service worker, and the Cloudflare
Worker. Changed: portrait photos get a pre-blurred backdrop instead of black bars.
