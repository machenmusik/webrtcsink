use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Error;

use async_std::net::{TcpListener, TcpStream};
use async_std::task;
use async_tungstenite::tungstenite::Message as WsMessage;
use clap::Parser;
use futures::channel::mpsc;
use futures::prelude::*;
use gst::glib::Type;
use gst::prelude::*;
use tracing::{debug, info, trace};
use tracing_subscriber::prelude::*;

#[derive(Parser, Debug)]
#[clap(about, version, author)]
/// Program arguments
struct Args {
    /// URI of file to serve. Must hold at least one audio and video stream
    //uri: String,
    /// Disable Forward Error Correction
    #[clap(long)]
    disable_fec: bool,
    /// Disable retransmission
    #[clap(long)]
    disable_retransmission: bool,
    /// Disable congestion control
    #[clap(long)]
    disable_congestion_control: bool,
}

fn serialize_value(val: &gst::glib::Value) -> Option<serde_json::Value> {
    match val.type_() {
        Type::STRING => Some(val.get::<String>().unwrap().into()),
        Type::BOOL => Some(val.get::<bool>().unwrap().into()),
        Type::I32 => Some(val.get::<i32>().unwrap().into()),
        Type::U32 => Some(val.get::<u32>().unwrap().into()),
        Type::I_LONG | Type::I64 => Some(val.get::<i64>().unwrap().into()),
        Type::U_LONG | Type::U64 => Some(val.get::<u64>().unwrap().into()),
        Type::F32 => Some(val.get::<f32>().unwrap().into()),
        Type::F64 => Some(val.get::<f64>().unwrap().into()),
        _ => {
            if let Ok(s) = val.get::<gst::Structure>() {
                serde_json::to_value(
                    s.iter()
                        .filter_map(|(name, value)| {
                            serialize_value(value).map(|value| (name.to_string(), value))
                        })
                        .collect::<HashMap<String, serde_json::Value>>(),
                )
                .ok()
            } else if let Ok(a) = val.get::<gst::Array>() {
                serde_json::to_value(
                    a.iter()
                        .filter_map(|value| serialize_value(value))
                        .collect::<Vec<serde_json::Value>>(),
                )
                .ok()
            } else if let Some((_klass, values)) = gst::glib::FlagsValue::from_value(val) {
                Some(
                    values
                        .iter()
                        .map(|value| value.nick())
                        .collect::<Vec<&str>>()
                        .join("+")
                        .into(),
                )
            } else if let Ok(value) = val.serialize() {
                Some(value.as_str().into())
            } else {
                None
            }
        }
    }
}

#[derive(Clone)]
struct Listener {
    id: uuid::Uuid,
    sender: mpsc::Sender<WsMessage>,
}

struct State {
    listeners: Vec<Listener>,
}

async fn run(args: Args) -> Result<(), Error> {
    tracing_log::LogTracer::init().expect("Failed to set logger");
    let env_filter = tracing_subscriber::EnvFilter::try_from_env("WEBRTCSINK_STATS_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_thread_ids(true)
        .with_target(true)
        .with_span_events(
            tracing_subscriber::fmt::format::FmtSpan::NEW
                | tracing_subscriber::fmt::format::FmtSpan::CLOSE,
        );
    let subscriber = tracing_subscriber::Registry::default()
        .with(env_filter)
        .with(fmt_layer);
    tracing::subscriber::set_global_default(subscriber).expect("Failed to set subscriber");

    let state = Arc::new(Mutex::new(State { listeners: vec![] }));

    let addr = "127.0.0.1:8484".to_string();

    let signaller_address = 
        //"wss://fortune-chlorinated-sheet.glitch.me/ws".to_string(); 
        "ws://127.0.0.1:8443".to_string();

    let video_prefs = "video/x-h264";
    let audio_prefs = "audio/x-opus";

    // Create the event loop and TCP listener we'll accept connections on.
    let try_socket = TcpListener::bind(&addr).await;
    let listener = try_socket.expect("Failed to bind");
    info!("Listening on: {}", addr);

    let gst_version_string = gst::version_string();
    println!("GStreamer {}", gst_version_string);

    let (major, minor, _point, _build) = gst::version();
    let gst_1_20_or_newer = major > 1 || minor >= 20;
    if gst_1_20_or_newer {
        println!("GStreamer 1.20 or newer");
    }
    let gst_newer_than_1_18 = major > 1 || minor > 18;
    if gst_newer_than_1_18 {
        println!("GStreamer newer than 1.18");
    }

    let webrtcsink_string = format!(
        "webrtcsink name=ws do-retransmission={} do-fec={} congestion-control={} signaller::address={} video-caps={} audio-caps={}", 
        //" stun-server={} turn-server={} min-bitrate={} max-bitrate={}",
        !args.disable_retransmission,
        !args.disable_fec,
        if args.disable_congestion_control {
            "disabled"
        } else {
            "homegrown"
        },
        signaller_address,
        video_prefs,
        audio_prefs
    );

    let mut video_only = false;
    let mut easy_button = false;

    let video_src_pipeline;

    if gst_1_20_or_newer {
        video_src_pipeline = "d3d11screencapturesrc ! d3d11convert ! d3d11download";
    } else
    if gst_newer_than_1_18 {
        video_src_pipeline = "d3d11desktopdupsrc ! d3d11convert ! d3d11download";
    } else {
        video_src_pipeline = "dxgiscreencapsrc ! videoscale ! videoconvert";
    }

    let video_width;
    let video_height;
    let video_framerate;
    let video_bitrate;
    let video_vbvsize;

    if easy_button {
        video_width = 960;
        video_height = 540;
        video_framerate = 30;
        video_bitrate = 900;
        video_vbvsize = video_bitrate / video_framerate;
    } else {
        video_width = 1920;
        video_height = 1080;
        video_framerate = 30; //60;
        video_bitrate = 3120; //1560; //3120;
        video_vbvsize = video_bitrate / video_framerate;
        // interestingly, recent experiments show that the limitation 
        // may be less with bit rate and more with some sort of pattern/structure?
        // 60 fps works initially, but freezes quickly / eventually
    }

    // Use I420 format, for compatibility with other encoders.
    let video_fmt_pipeline = format!(
        "! video/x-raw,format=NV12,width={},height={},framerate={}000/1001", 
        video_width, video_height, video_framerate);

    let audio_src_pipeline;

    if video_only {
        audio_src_pipeline = format!("");
    } else {
        let audio_src;
        if gst_1_20_or_newer {
            audio_src = "wasapi2src";
        } else {
            audio_src = "wasapisrc";
        }
        audio_src_pipeline = format!(
            "{} loopback=true low-latency=true provide-clock=true do-timestamp=true ", audio_src); 
    }

    let pipeline_string = &format!("{}       {} {} ! queue ! ws.video_0      {} ! audio/x-raw ! queue ! ws.audio_0",
        webrtcsink_string,
        video_src_pipeline, /* "! video/x-raw", */ video_fmt_pipeline,
        audio_src_pipeline);

    println!("creating pipeline {}", pipeline_string);

    let pipeline = gst::parse_launch(&pipeline_string)?;
    let ws = pipeline
        .downcast_ref::<gst::Bin>()
        .unwrap()
        .by_name("ws")
        .unwrap();

    let ws_clone = ws.downgrade();
    let state_clone = state.clone();
    task::spawn(async move {
        let mut interval = async_std::stream::interval(std::time::Duration::from_millis(100));

        while interval.next().await.is_some() {
            if let Some(ws) = ws_clone.upgrade() {
                let stats = ws.property::<gst::Structure>("stats");
                let stats = serialize_value(&stats.to_value()).unwrap();
                debug!("Stats: {}", serde_json::to_string_pretty(&stats).unwrap());
                let msg = WsMessage::Text(serde_json::to_string(&stats).unwrap());

                let listeners = state_clone.lock().unwrap().listeners.clone();

                for mut listener in listeners {
                    if listener.sender.send(msg.clone()).await.is_err() {
                        let mut state = state_clone.lock().unwrap();
                        let index = state
                            .listeners
                            .iter()
                            .position(|l| l.id == listener.id)
                            .unwrap();
                        state.listeners.remove(index);
                    }
                }
            } else {
                break;
            }
        }
    });

    pipeline.set_state(gst::State::Playing)?;

    while let Ok((stream, _)) = listener.accept().await {
        task::spawn(accept_connection(state.clone(), stream));
    }

    Ok(())
}

async fn accept_connection(state: Arc<Mutex<State>>, stream: TcpStream) {
    let addr = stream
        .peer_addr()
        .expect("connected streams should have a peer address");
    info!("Peer address: {}", addr);

    let mut ws_stream = async_tungstenite::accept_async(stream)
        .await
        .expect("Error during the websocket handshake occurred");

    info!("New WebSocket connection: {}", addr);

    let mut state = state.lock().unwrap();
    let (sender, mut receiver) = mpsc::channel::<WsMessage>(1000);
    state.listeners.push(Listener {
        id: uuid::Uuid::new_v4(),
        sender,
    });
    drop(state);

    task::spawn(async move {
        while let Some(msg) = receiver.next().await {
            trace!("Sending to one listener!");
            if ws_stream.send(msg).await.is_err() {
                info!("Listener errored out");
                receiver.close();
            }
        }
    });
}

fn main() -> Result<(), Error> {
    gst::init()?;

    let args = Args::parse();

    task::block_on(run(args))
}
