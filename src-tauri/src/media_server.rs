use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use http_range::HttpRange;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub struct MediaServer {
    address: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl MediaServer {
    pub fn start() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let server = Arc::new(Server::http((Ipv4Addr::LOCALHOST, 0))?);
        let address = server.server_addr().to_string();
        let files = Arc::new(Mutex::new(HashMap::new()));

        // Keep disk transfers off the UI thread and bounded even while several tracks preload.
        for _ in 0..12 {
            let server = Arc::clone(&server);
            let files = Arc::clone(&files);
            let address = address.clone();
            thread::Builder::new()
                .name("media-stream".into())
                .spawn(move || {
                    for request in server.incoming_requests() {
                        handle_request(request, &address, &files);
                    }
                })?;
        }

        Ok(Self { address, files })
    }

    pub fn url(&self, path: &str) -> Result<String, String> {
        let path = std::fs::canonicalize(path).map_err(|e| format!("Could not open media: {e}"))?;
        if !path.is_file() || content_type(&path).is_none() {
            return Err("Choose a supported video or audio file.".into());
        }

        let mut files = self.files.lock().map_err(|e| e.to_string())?;
        let token = match files.iter().find(|(_, registered)| **registered == path) {
            Some((token, _)) => token.clone(),
            None => {
                let high = getrandom::u64().map_err(|e| e.to_string())?;
                let low = getrandom::u64().map_err(|e| e.to_string())?;
                let token = format!("{high:016x}{low:016x}");
                files.insert(token.clone(), path);
                token
            }
        };
        Ok(format!("http://{}/{token}", self.address))
    }
}

fn handle_request(request: Request, address: &str, files: &Mutex<HashMap<String, PathBuf>>) {
    if !matches!(request.method(), Method::Get | Method::Head) {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return;
    }

    let path = request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Host") && header.value.as_str() == address)
        .then(|| {
            let token = request.url().strip_prefix('/')?;
            files.lock().ok()?.get(token).cloned()
        })
        .flatten();
    let Some(path) = path else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Some((mut file, total, mime)) = open_media(&path) else {
        let _ = request.respond(Response::empty(StatusCode(404)));
        return;
    };

    let mut headers = vec![
        header("Accept-Ranges", "bytes"),
        header("Content-Type", mime),
        header("Cache-Control", "no-store"),
    ];
    let range_header = request.headers().iter().find(|h| h.field.equiv("Range"));
    let (status, start, length) = if let Some(range) = range_header {
        match HttpRange::parse(range.value.as_str(), total).as_deref() {
            Ok([HttpRange { start, length }]) if *length > 0 => {
                let end = start + length - 1;
                headers.push(header(
                    "Content-Range",
                    &format!("bytes {start}-{end}/{total}"),
                ));
                (206, *start, *length)
            }
            _ => {
                let response = Response::empty(StatusCode(416))
                    .with_header(header("Content-Range", &format!("bytes */{total}")));
                let _ = request.respond(response);
                return;
            }
        }
    } else {
        (200, 0, total)
    };

    if file.seek(SeekFrom::Start(start)).is_err() {
        let _ = request.respond(Response::empty(StatusCode(500)));
        return;
    }
    let response = Response::new(
        StatusCode(status),
        headers,
        file.take(length),
        Some(length as usize),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

fn open_media(path: &Path) -> Option<(File, u64, &'static str)> {
    let mime = content_type(path)?;
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    metadata.is_file().then_some((file, metadata.len(), mime))
}

fn content_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        _ => None,
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid media response header")
}
