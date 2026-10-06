# College Bus Live Tracking — Architecture

```text
Driver Phone Browser
  └─ navigator.geolocation.watchPosition()
       └─ HTTPS/LAN JSON → Node.js + Express
             ├─ SQLite: users, buses, trips, GPS history, stops, requests, alerts
             ├─ OSRM: road route geometry at trip start
             └─ Socket.IO → live GPS / trip / alert events
                         ├─ Student Browser → Leaflet map + ETA + arrival alert
                         └─ Admin Browser → live fleet monitor
```

## Core flow
1. Driver signs in.
2. Driver selects an assigned bus and chooses start/destination.
3. Backend creates an active trip and obtains road route geometry from OSRM.
4. Browser starts `watchPosition` and posts GPS points continuously.
5. Server stores each GPS point and broadcasts `gps:update` over Socket.IO.
6. Student searches pickup and destination; active matching trips are returned.
7. Student map receives live GPS updates and displays route/stops.
8. When bus GPS is within 150 m of a requested pickup location, server creates an alert and emits a private `bus:arrived` event.
9. Admin can manage buses/drivers and inspect recent trip history.
