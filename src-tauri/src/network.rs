//! Minimal WebSocket relay for the game host.
//!
//! Rust only moves text frames between remote clients and the host's frontend, where the
//! authoritative TypeScript engine validates everything. Limits are enforced here:
//! number of connections, frame/message size, outgoing queue length.

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

pub const MAX_CONNECTIONS: usize = 16;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Host -> client frames (snapshots) may be larger than client -> host frames.
pub const MAX_OUTGOING_BYTES: usize = 8 * 1024 * 1024;
const OUT_QUEUE: usize = 256;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct NetEvent {
    pub kind: &'static str,
    pub conn: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub type EventSink = Arc<dyn Fn(NetEvent) + Send + Sync>;
type Conns = Arc<Mutex<HashMap<u32, mpsc::Sender<Message>>>>;

pub struct Server {
    pub port: u16,
    conns: Conns,
    accept: JoinHandle<()>,
}

impl Server {
    pub async fn start(port: u16, sink: EventSink) -> Result<Server, String> {
        let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
            .await
            .map_err(|e| format!("Impossible d'ouvrir le port {port} : {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let conns: Conns = Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(AtomicU32::new(1));
        let accept_conns = conns.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                if accept_conns.lock().unwrap().len() >= MAX_CONNECTIONS {
                    drop(stream); // refuse beyond the connection limit
                    continue;
                }
                let id = next_id.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(handle(stream, id, accept_conns.clone(), sink.clone()));
            }
        });
        Ok(Server { port, conns, accept })
    }

    pub fn send(&self, conn: u32, text: String) -> Result<(), String> {
        if text.len() > MAX_OUTGOING_BYTES {
            return Err("Message trop volumineux.".into());
        }
        let tx = self.conns.lock().unwrap().get(&conn).cloned();
        match tx {
            // A full queue means the peer does not read: drop it rather than grow without bound.
            Some(tx) => tx.try_send(Message::Text(text)).map_err(|_| {
                self.conns.lock().unwrap().remove(&conn);
                "Connexion saturée.".to_string()
            }),
            None => Err("Connexion inconnue.".into()),
        }
    }

    pub fn close(&self, conn: u32) {
        if let Some(tx) = self.conns.lock().unwrap().remove(&conn) {
            let _ = tx.try_send(Message::Close(None));
        }
    }

    pub fn stop(&self) {
        self.accept.abort();
        for (_, tx) in self.conns.lock().unwrap().drain() {
            let _ = tx.try_send(Message::Close(None));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn handle(stream: TcpStream, id: u32, conns: Conns, sink: EventSink) {
    let _ = stream.set_nodelay(true);
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    let Ok(ws) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await else { return };
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(OUT_QUEUE);
    conns.lock().unwrap().insert(id, tx);
    sink(NetEvent { kind: "open", conn: id, text: None });
    let mut writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let closing = matches!(msg, Message::Close(_));
            if write.send(msg).await.is_err() || closing {
                break;
            }
        }
        let _ = write.close().await;
    });
    loop {
        tokio::select! {
            // The writer ends when the host closes the connection or the peer stops reading:
            // do not wait for a closing handshake that a silent peer would never send.
            _ = &mut writer => break,
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => sink(NetEvent { kind: "message", conn: id, text: Some(text) }),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                // Close, binary (the protocol is text-only), oversized frame or socket error.
                _ => break,
            },
        }
    }
    conns.lock().unwrap().remove(&id);
    writer.abort();
    sink(NetEvent { kind: "close", conn: id, text: None });
}

/// Local addresses a LAN player can use. No packet is sent: connecting a UDP socket only
/// asks the OS which interface would route to a public address.
pub fn local_addresses() -> Vec<String> {
    let mut out = Vec::new();
    for target in ["192.0.2.1:9", "10.255.255.255:9"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    let ip = addr.ip().to_string();
                    if ip != "0.0.0.0" && !out.contains(&ip) {
                        out.push(ip);
                    }
                }
            }
        }
    }
    out.push("127.0.0.1".into());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;
    use tokio_tungstenite::connect_async;

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<NetEvent>) -> NetEvent {
        timeout(Duration::from_secs(5), rx.recv()).await.expect("event timeout").expect("channel closed")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relays_text_both_ways_and_reports_lifecycle() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server = Server::start(0, Arc::new(move |e| { let _ = tx.send(e); })).await.unwrap();
        let url = format!("ws://127.0.0.1:{}", server.port);
        let (mut client, _) = connect_async(&url).await.unwrap();
        let open = next_event(&mut rx).await;
        assert_eq!(open.kind, "open");
        client.send(Message::Text("{\"t\":\"hello\"}".into())).await.unwrap();
        let msg = next_event(&mut rx).await;
        assert_eq!((msg.kind, msg.conn, msg.text.as_deref()), ("message", open.conn, Some("{\"t\":\"hello\"}")));
        server.send(open.conn, "welcome".into()).unwrap();
        let got = timeout(Duration::from_secs(5), client.next()).await.unwrap().unwrap().unwrap();
        assert_eq!(got, Message::Text("welcome".into()));
        assert!(server.send(999, "x".into()).is_err());
        client.close(None).await.unwrap();
        assert_eq!(next_event(&mut rx).await.kind, "close");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn oversized_frames_close_the_connection() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server = Server::start(0, Arc::new(move |e| { let _ = tx.send(e); })).await.unwrap();
        let (mut client, _) = connect_async(format!("ws://127.0.0.1:{}", server.port)).await.unwrap();
        assert_eq!(next_event(&mut rx).await.kind, "open");
        let _ = client.send(Message::Text("x".repeat(MAX_MESSAGE_BYTES + 1024))).await;
        assert_eq!(next_event(&mut rx).await.kind, "close"); // never delivered as a message
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connection_limit_and_host_side_close() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server = Server::start(0, Arc::new(move |e| { let _ = tx.send(e); })).await.unwrap();
        let url = format!("ws://127.0.0.1:{}", server.port);
        let mut clients = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            clients.push(connect_async(&url).await.unwrap().0);
            assert_eq!(next_event(&mut rx).await.kind, "open");
        }
        assert!(connect_async(&url).await.is_err(), "connection beyond the limit must be refused");
        server.close(1);
        let closed = next_event(&mut rx).await;
        assert_eq!((closed.kind, closed.conn), ("close", 1));
        assert!(!local_addresses().is_empty());
    }
}
