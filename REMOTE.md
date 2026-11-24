# Remote access guide

Use your Plexar Studio sessions from your phone or from another computer. Everything here
lives on one page: **Settings ▸ Remote**. Remote access is off until you turn it on.

The page has two tabs:

- **Let devices in**: set up *this* computer so a phone or another computer can reach it.
- **Control another machine**: connect *from* this computer to a Studio running elsewhere.

## Let devices in

Three steps, top to bottom. Once they are done the steps fold into one status line; press
**Change setup** to change anything.

### 1 · Turn on remote access

Tick **Enable remote access to this machine** and save. Nothing outside this computer can
reach Studio while this is off.

### 2 · How devices reach this machine

Pick the one answer that fits you.

| Choice | Pick it when | You need |
|---|---|---|
| **Only devices on this network** | Both devices are on the same home or office network | Nothing else |
| **I have a Cloudflare Tunnel token** (Studio runs the connector) | You want to connect from anywhere | A Cloudflare account and a domain |
| **I already have an address for this machine** | You run your own tunnel, VPN or reverse proxy | An address that forwards to Studio on this computer |

#### Only devices on this network

The simplest choice. No account, no domain.

1. Select **Only devices on this network** and save.
2. Windows may ask whether to allow Plexar Studio on the network. Allow it for private networks.
3. The page shows `Listening at http://<this computer's address>:8421`. You can change the port.

Things to know:

- It works only while the other device is on the same network.
- This connection is not encrypted. Use it only on a network you trust.
- Only the paired-device routes are offered on this port. The rest of Studio stays
  unreachable from the network, and only private-network addresses are served.
- Another computer running Studio can connect this way. Plexar Mobile on Android does not
  yet accept an unencrypted local address, so a phone needs one of the other two choices.

#### I have a Cloudflare Tunnel token

Studio runs Cloudflare's `cloudflared` program for you, keeps it hidden, and restarts it if
it stops. You do not need a Windows service or a scheduled task.

1. Install `cloudflared` on this computer: `winget install --id Cloudflare.cloudflared`.
2. In the Cloudflare dashboard, open **Zero Trust ▸ Networks ▸ Tunnels** and create a tunnel.
3. Add a public hostname to the tunnel, for example `studio.example.com`:
   - Service: `http://localhost:8420`
   - Path: `^/remote/v1/`

   **The path is the important part.** Without it the tunnel publishes every route Studio
   has, and most of them have no sign-in. With it, only the paired-device routes are reachable.
4. Copy the tunnel's connector token (the long string after `--token` in the install command
   Cloudflare shows).
5. In Studio, select **I have a Cloudflare Tunnel token**, paste the token, enter the
   address (`https://studio.example.com`) and save. Press **Start**.
6. The page should read `running` with a connection count. **Test public URL** checks the
   address from the outside.

Keep **Run when Studio starts** ticked so the connector comes up with the app. The token is
stored beside your API keys, never in the exportable settings file, and is never shown again.

If you also protect the hostname with Cloudflare Access, tick **Cloudflare Access is
required in front of this tunnel**. The phone then signs in to Access as well as pairing.

#### I already have an address for this machine

For a tunnel, VPN address or reverse proxy you run yourself. Enter the address and save.

Studio itself listens only on this computer, so your tunnel or proxy must run here and
forward to `http://127.0.0.1:8420`. Forward only paths that start with `/remote/v1/`.

### 3 · Pair a device

The address only gets a device to this machine. It still has to be paired before it can do
anything.

Press **Pair a device**. A code appears for five minutes and works once.

- **Phone:** scan the code in Plexar Mobile.
- **Another computer:** copy the pairing link and paste it on the other computer (see below).

Paired devices are listed at the bottom with when they were last seen. **Revoke** cuts a
device off immediately. A device not seen for 30 days is flagged so you can tidy up.

## Control another machine

On the computer you are sitting at:

1. On the *other* computer, do the three steps above and copy its pairing link.
2. Here, open **Settings ▸ Remote ▸ Control another machine**.
3. Paste the link under **Pair another machine**.
4. If the other machine sits behind Cloudflare Access, also enter an Access service token
   (client id and secret). Without one the machine is listed as needing Access.

The machine then appears in your sidebar. You can see its sessions, start and end them, and
open one in a pane like a local session.

## What a paired device can do

See your sessions, start and end them, read their output and type into them. It cannot
change Studio's settings, read your API keys or reach anything else on the computer's local
server. Each device holds its own token; revoking one does not affect the others.

## Troubleshooting

- **Pairing is greyed out.** The line under the button says why: remote access is off, no
  address is saved, or the local listener could not start.
- **"Port 8421 is not available".** Another program uses that port. Pick a different one.
- **Local mode listens, but the other computer cannot connect.** Check the Windows firewall
  prompt was allowed for private networks, and that both devices are on the same network.
- **"Another cloudflared is also running".** That is fine if it serves a different tunnel.
  Stop one only if both are connectors for this same tunnel.
- **The pairing code is refused.** Codes last five minutes and five wrong tries cancel them.
  Press **Pair a device** again for a new one.
