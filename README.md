# College Bus Live – Phase 7

Real-time college bus tracking using browser GPS.

## Login model
- Exactly one administrator account is seeded: `admin` / `Admin@123`.
- Driver accounts are **not self-registered**. The administrator creates each driver account after verifying the driver's documents and issues a unique User ID based on the driver's name.
- Driver User IDs are unique and required for login.
- Students can create their own student User ID and password from the login screen, or use the demo student account `student` / `Student@123`.
- Passwords are stored as bcrypt hashes.

## Driver registration
Admin Dashboard → **Driver Management** → register driver with:
- Full name
- Unique User ID
- Initial password
- Verified document type
- Verified document number/reference

Only verified driver accounts can log in with the `driver` role.

## Demo accounts
- Admin: `admin` / `Admin@123`
- Student: `student` / `Student@123`

A driver demo account is intentionally not seeded; create one from Admin → Driver Management.

## Run
Server:
```bash
cd server
npm install
node server.js
# or: npm start
```

Client:
```bash
cd client
npm install
npm run dev -- --host 0.0.0.0
```

## Fixed college destination

All buses now use one fixed college destination; the administrator does not enter a destination for each bus and students do not choose a different destination.

- College: Vignan's Institute of Information Technology (VIIT)
- Latitude: `17.7106243`
- Longitude: `83.1637641`
- Google Maps: https://www.google.com/maps/search/?api=1&query=17.7106243,83.1637641

Only the morning starting point and pickup stops are configured per bus. Existing buses are automatically updated to this fixed destination when the server starts.
