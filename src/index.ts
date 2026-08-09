import * as net from 'net';
import * as dgram from 'dgram';
import * as dns from 'dns';
import * as fs from 'fs';
import * as ini from 'ini';

const INI_FILE_PATH = './resources/settings.ini';
// NOTE: these feed servers (sactoatcs.dyndns.org and friends) run on
// volunteers' home connections behind DynDNS. Their IP changes whenever the
// operator's ISP reassigns them a new address, so we must never hardcode an
// IP for them -- always resolve the hostname fresh, and always subscribe to
// whichever host actually answered the TCP handshake.
const PRIMARY_SERVER = 'www.atcsmon.com';
const PRIMARY_PORT = 4830;
const FALLBACK_SERVER = 'sactoatcs.dyndns.org';
const SUBSCRIPTION_PAYLOAD = Buffer.from([0x34, 0x2e, 0x31, 0x2e, 0x30]); // "4.1.0"
import { parseMcpFile, McpDictionary } from './mcpParser';

const mcpDict = parseMcpFile('./resources/layout.mcp');

/**
 * Maps raw payload bytes to physical railroad indications.
 * @param address The routing address (e.g., "77080160470202")
 * @param packetData The raw data payload buffer from the UDP stream
 */
function decodeIndicationPayload(address: string, payloadData: Buffer) {
    const station = mcpDict[address];
    if (!station) {
        console.log(`Unknown address: ${address}`);
        return null;
    }

    const activeStates: string[] = [];
    let currentBitIndex = 0;

    // Iterate directly over the isolated payload
    for (let i = 0; i < payloadData.length; i++) {
        const byte = payloadData[i];

        for (let bit = 0; bit < 8; bit++) {
            const isSet = (byte & (1 << (7 - bit))) !== 0;

            if (isSet) {
                if (currentBitIndex < station.indicationMnemonics.length) {
                    const mnemonic = station.indicationMnemonics[currentBitIndex];
                    if (mnemonic && mnemonic.trim() !== '') {
                        activeStates.push(mnemonic);
                    } else {
                        activeStates.push(`K${currentBitIndex + 1}`);
                    }
                } else {
                    activeStates.push(`K${currentBitIndex + 1}`);
                }
            }
            currentBitIndex++;
        }
    }
    console.log(`[${station.name} / ${station.subdivision}] Active: ${activeStates.join(', ')}`);
    return activeStates;
}

function processPacket(data: Buffer): boolean {
    // Filter out keep-alives and fragments
    if (data.length < 10)
        return false;

    const protocolByte = data[0];
    switch (protocolByte) {
    case 0x67: // 'g' - Genisys
        // parseGenisysPacket(data);
        return false;

    case 0x23: // '#' - ATCS
        parseAtcsPacket(data);
        return true;

    default:
        // console.log(`Unknown protocol byte: 0x${protocolByte.toString(16)}`);
        return false;
    }
}

function parseGenisysPacket(data: Buffer) {
    const fullString = data.toString('ascii');
    const addressMatch = fullString.match(/^g(\d+)/);
    
    if (!addressMatch) return;

    const baseAddress = addressMatch[1]; 
    
    // Isolate the binary payload
    const payloadStartIndex = 1 + baseAddress.length; 
    const payloadBytes = data.subarray(payloadStartIndex);

    // Genisys packets must have at least Station ID, Status, Data, and CRC
    if (payloadBytes.length < 4) return;

    // Extract the Station ID (Byte 0)
    const stationId = payloadBytes[0];
    
    // Build the final 13-digit MCP Address
    // Prefix '8' + Base Address + 3-digit zero-padded Station ID
    const paddedStationId = stationId.toString().padStart(3, '0');
    const mcpAddress = `8${baseAddress}${paddedStationId}`;

    // Isolate the actual Indication bits
    const indicationBytes = payloadBytes.subarray(2, payloadBytes.length - 1);

    console.log(`[Genisys] Address: ${mcpAddress} | State Bytes: ${indicationBytes.toString('hex')}`);

    // decodeIndicationPayload(mcpAddress, indicationBytes);
}

function parseAtcsPacket(data: Buffer) {
    if (data.length < 15) return;

    const lengthsByte = data[9];
    const sourceDigits = lengthsByte >> 4;
    const destDigits = lengthsByte & 0x0F;

    const destBytes = Math.ceil(destDigits / 2);
    const sourceBytes = Math.ceil(sourceDigits / 2);

    const destOffset = 10;
    const sourceOffset = destOffset + destBytes;
    
    if (sourceOffset + sourceBytes > data.length) return;

    const rawHexAddress = data.subarray(sourceOffset, sourceOffset + sourceBytes).toString('hex');
    const cleanAddress = rawHexAddress.replace(/a/gi, '0');

    // DYNAMIC HEADER SEARCH: Scan forward up to 15 bytes to find the 9.2.11 signature (0x12 0x8B)
    const searchStart = sourceOffset + sourceBytes;
    let appOffset = -1;

    for (let i = searchStart; i <= searchStart + 15 && i < data.length - 1; i++) {
        if (data[i] === 0x12 && data[i + 1] === 0x8B) {
            appOffset = i;
            break;
        }
    }

    if (appOffset === -1)
        return;
    
    // The payload length is always 4 bytes after the 12 8B signature
    const payloadLength = data[appOffset + 4]; 
    
    // The actual indication bytes start 6 bytes after the signature
    // Skipping: 12 8B (ID) -> 03 00 (Flags) -> XX (Length) -> 08 (Static byte)
    const payloadStart = appOffset + 6;
    
    if (payloadStart + payloadLength > data.length - 2) {
        return; // Malformed packet
    }

    const payloadBytes = data.subarray(payloadStart, payloadStart + payloadLength);
    decodeIndicationPayload(cleanAddress, payloadBytes);
}

// Interface for server configuration
interface ServerConfig {
  address: string;
  tcpPort: number;
}

// Parse INI file
const config = ini.parse(fs.readFileSync(INI_FILE_PATH, 'utf-8'));
const servers: ServerConfig[] = [];
for (let i = 0; i <= 30; i++) {
  const address = config.Settings[`ServerAddress${i}`] || (i === 0 ? FALLBACK_SERVER : '');
  const port = config.Settings[`ServerPort${i}`];
  const enabled = config.Settings[`ServerEnabled${i}`];
  if (address && port && enabled === 'True') {
    servers.push({ address, tcpPort: parseInt(port) });
  }
}

// Log formatting
function logPacket(protocol: string, source: string, data: Buffer): void {
  const timestamp = new Date().toISOString();
  const ascii = data.toString('ascii').replace(/[^ -~]/g, '.');
  console.log(`[${timestamp}] ${protocol} Received ${data.length} bytes from ${source}\nRaw hex: ${data.toString('hex')}\nASCII: ${ascii}`);
}

// Store UDP ports received from TCP responses
const udpPorts: number[] = [];
const udpSockets: dgram.Socket[] = [];

// Function to create UDP socket for a given (local bind port, remote server port) pair.
// `targetHost` is the hostname that just answered us via TCP -- we resolve
// it ourselves, right before sending, instead of trusting a cached/hardcoded
// IP that may be stale (see note on FALLBACK_SERVER above).
//
// IMPORTANT: `localPort` and `remotePort` are NOT the same number, and must
// not be conflated (this was the bug). Per the Wireshark capture, the real
// app subscribes to UDP data from the SAME local port its TCP connection to
// that server used (e.g. TCP src port 49657 -> UDP src port 49657), and
// sends that subscription TO the port number the server announced over TCP
// (e.g. UDP dst port 16050). The server then replies to whatever source
// port the subscription arrived FROM -- ordinary UDP request/reply
// behavior -- which is the TCP-derived local port, not the announced one.
// Binding locally to the announced port instead (the old code) put the
// subscription's source port on 16050, so replies -- sent by the server
// back to the client's real TCP-connection local port -- landed on a port
// nothing was listening on and were silently dropped.
function createUdpSocket(localPort: number, remotePort: number, targetHost: string) {
  if (udpPorts.includes(localPort)) return; // Avoid duplicate sockets
  udpPorts.push(localPort);
  const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket.on('listening', () => {
    console.log(`UDP Socket bound to port ${localPort} for broadcasts`);
  });
  udpSocket.on('message', (msg: Buffer, rinfo) => {
    // The server periodically pings with a plaintext "*KEEPALIVE" datagram
    // (first byte 0x2a, doesn't match either protocolByte case in
    // processPacket). Per the reference capture, the real app must echo the
    // subscription payload straight back in response -- the very first
    // KEEPALIVE reply is what promotes the connection from "subscribed" to
    // actually streaming indication data; without answering it, the server
    // just sits idle and eventually tears down the TCP side. Later
    // KEEPALIVEs during an active stream get the same echo.
    if (msg.toString('ascii') === '*KEEPALIVE') {
      udpSocket.send(SUBSCRIPTION_PAYLOAD, rinfo.port, rinfo.address, (err) => {
        if (err) console.error(`UDP Keepalive Ack Error to ${rinfo.address}:${rinfo.port}: ${err.message}`);
        else console.log(`Received KEEPALIVE from ${rinfo.address}:${rinfo.port}, echoed subscription`);
      });
      return;
    }

    if (processPacket(msg)) {
      logPacket('UDP', `${rinfo.address}:${rinfo.port}`, msg);
      console.log("-------------------------------");
    }
  });
  udpSocket.on('error', (err) => {
    console.error(`UDP Error on port ${localPort}: ${err.message}`);
  });
  udpSocket.bind(localPort, '0.0.0.0', () => {
    udpSocket.setBroadcast(true);
    // Resolve targetHost fresh every time -- for a DynDNS name the
    // underlying IP can rotate between sessions (or even during one).
    dns.lookup(targetHost, (lookupErr, resolvedIp) => {
      if (lookupErr) {
        console.error(`DNS lookup failed for ${targetHost}: ${lookupErr.message}`);
        return;
      }
      console.log(`Resolved ${targetHost} -> ${resolvedIp} for UDP subscription`);
      udpSocket.send(SUBSCRIPTION_PAYLOAD, remotePort, resolvedIp, (err) => {
        if (err) console.error(`UDP Send Error to ${resolvedIp}:${remotePort}: ${err.message}`);
        else console.log(`Sent UDP subscription from local port ${localPort} to ${resolvedIp}:${remotePort}: ${SUBSCRIPTION_PAYLOAD.toString('hex')}`);
      });
    });
  });
  udpSockets.push(udpSocket);
}

// Function to create TCP connection
function createTcpConnection(address: string, port: number) {
  const tcpClient = net.createConnection({ host: address, port }, () => {
    console.log(`TCP Connected to ${address}:${port}`);
  });

  tcpClient.on('data', (data) => {
    console.log(logPacket('TCP', `${address}:${port}`, data));
    // Parse response for port numbers
    const responseStr = data.toString('ascii');
    const portMatch = responseStr.match(/\d{4,5}/);
    if (portMatch) {
      const newPort = parseInt(portMatch[0]);
      console.log(`Detected UDP port ${newPort} from ${address}:${port}`);
      // Subscribe with the SAME host that handed us this port -- `address`
      // is whichever hostname (www.atcsmon.com or an INI server such as
      // sactoatcs.dyndns.org) actually answered this TCP connection.
      // Bind the UDP socket to tcpClient.localPort (this connection's own
      // ephemeral local port), NOT to newPort -- see the comment on
      // createUdpSocket for why.
      if (tcpClient.localPort) {
        createUdpSocket(tcpClient.localPort, newPort, address);
      } else {
        console.error(`No local port available on TCP socket for ${address}:${port}, cannot subscribe to UDP ${newPort}`);
      }
      // Previously this also opened a second TCP connection to
      // FALLBACK_SERVER on `newPort`, treating the UDP port number as a TCP
      // port on the same host. That's not part of the protocol -- newPort is
      // only for local UDP binding -- and it's what produced the
      // `ETIMEDOUT ...:16072` / `...:16051` errors in your log. Removed.
    }
  });

  tcpClient.on('error', (err) => {
    console.error(`TCP Error for ${address}:${port}: ${err.message}`);
  });

  tcpClient.on('end', () => {
    console.log(`TCP Disconnected from ${address}:${port}`);
  });

  // Send periodic keepalives
  setInterval(() => {
    if (tcpClient.writable) {
      tcpClient.write(SUBSCRIPTION_PAYLOAD);
      console.log(`Sent TCP keepalive to ${address}:${port}`);
    }
  }, 30000);
}

// Initial connection to www.atcsmon.com
createTcpConnection(PRIMARY_SERVER, PRIMARY_PORT);

// Fallback to INI file servers if needed
setTimeout(() => {
  if (udpPorts.length === 0) {
    console.log('No UDP ports received from www.atcsmon.com, falling back to INI servers');
    servers.forEach((server) => {
      createTcpConnection(server.address, server.tcpPort);
    });
  }
}, 10000); // Wait 10 seconds for primary server response

// Keep process alive
process.on('SIGINT', () => {
  console.log('Shutting down...');
  udpSockets.forEach((socket) => socket.close());
  process.exit(0);
});