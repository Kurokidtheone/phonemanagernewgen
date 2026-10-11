use std::{sync::Arc, time::Duration};

use remote::{
    fake::FakeSupabase, send_sealed, Backoff, Dir, Error, Inbox, Incoming, Mailbox, WakeListener,
};
use tokio::{sync::Notify, time::timeout};
use wire::{new_key, new_mailbox, open, seal};

async fn setup() -> (FakeSupabase, Mailbox, String) {
    let fake = FakeSupabase::start().await;
    let mb = Mailbox::new(fake.config());
    let mailbox = new_mailbox();
    assert!(!mb.beat(&mailbox, "shop-1", "Shop").await.unwrap());
    (fake, mb, mailbox)
}

#[tokio::test]
async fn send_fetch_ack_and_ordering() {
    let (fake, mb, m) = setup().await;
    let a = mb.send(&m, Dir::ToPc, "one").await.unwrap();
    let b = mb.send(&m, Dir::ToPc, "two").await.unwrap();
    let c = mb.send(&m, Dir::ToPc, "three").await.unwrap();
    mb.send(&m, Dir::ToPhone, "reply").await.unwrap();
    assert!(a < b && b < c);

    let rows = mb.fetch(&m, Dir::ToPc, 0).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| r.body.as_str()).collect::<Vec<_>>(),
        ["one", "two", "three"]
    );
    // Directions do not mix.
    let back = mb.fetch(&m, Dir::ToPhone, 0).await.unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].body, "reply");
    // After a cursor.
    assert_eq!(mb.fetch(&m, Dir::ToPc, a).await.unwrap().len(), 2);
    // Ack removes delivered rows only.
    mb.ack(&m, Dir::ToPc, b).await.unwrap();
    let left = mb.fetch(&m, Dir::ToPc, 0).await.unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].body, "three");
    assert_eq!(fake.waiting().len(), 2);
}

#[tokio::test]
async fn fetch_returns_at_most_50_and_the_inbox_pages() {
    let (_fake, mb, m) = setup().await;
    for i in 0..120 {
        mb.send(&m, Dir::ToPc, &format!("{{\"n\":\"{i}\",\"c\":\"x\"}}"))
            .await
            .unwrap();
    }
    assert_eq!(mb.fetch(&m, Dir::ToPc, 0).await.unwrap().len(), 50);
    let mut inbox = Inbox::new(mb.clone(), &m, Dir::ToPc);
    let got = inbox.poll().await.unwrap();
    assert_eq!(got.len(), 120);
    // Fetched rows are not returned twice, even before they are acked.
    assert!(inbox.poll().await.unwrap().is_empty());
}

#[tokio::test]
async fn seen_reports_age_or_none() {
    let (fake, mb, m) = setup().await;
    assert!(mb.seen(&m).await.unwrap().unwrap() < 5);
    fake.age_last_seen(&m, Duration::from_secs(90));
    assert!(mb.seen(&m).await.unwrap().unwrap() >= 90);
    assert_eq!(mb.seen(&new_mailbox()).await.unwrap(), None);
}

#[tokio::test]
async fn split_messages_are_joined_and_open() {
    let (_fake, mb, m) = setup().await;
    let key = new_key();
    let plain: Vec<u8> = (0..2_000_000u32).map(|i| (i % 253) as u8).collect();
    let sealed = seal(&key, &m, "dev", &plain).unwrap();
    send_sealed(&mb, &m, Dir::ToPc, "req-1", &sealed)
        .await
        .unwrap();

    let mut inbox = Inbox::new(mb.clone(), &m, Dir::ToPc);
    let got = inbox.poll().await.unwrap();
    assert_eq!(got.len(), 1);
    let Incoming::Message {
        sealed: back,
        last_row,
    } = &got[0]
    else {
        panic!("expected a message")
    };
    assert_eq!(open(&key, &m, "dev", back).unwrap(), plain);
    inbox.ack(*last_row).await.unwrap();
    assert!(mb.fetch(&m, Dir::ToPc, 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn garbage_is_reported_as_bad() {
    let (_fake, mb, m) = setup().await;
    mb.send(&m, Dir::ToPc, "not a message").await.unwrap();
    let mut inbox = Inbox::new(mb, &m, Dir::ToPc);
    assert!(matches!(
        inbox.poll().await.unwrap()[0],
        Incoming::Bad { .. }
    ));
}

#[tokio::test]
async fn blocked_mailbox() {
    let (fake, mb, m) = setup().await;
    fake.block(&m, true);
    assert!(mb.beat(&m, "shop-1", "Shop").await.unwrap());
    assert_eq!(mb.send(&m, Dir::ToPc, "x").await, Err(Error::Blocked));
    fake.block(&m, false);
    assert!(mb.send(&m, Dir::ToPc, "x").await.is_ok());
}

#[tokio::test]
async fn unknown_and_bad_mailbox_and_big_body() {
    let (_fake, mb, m) = setup().await;
    assert_eq!(
        mb.send(&new_mailbox(), Dir::ToPc, "x").await,
        Err(Error::Unknown)
    );
    assert_eq!(
        mb.send("short", Dir::ToPc, "x").await,
        Err(Error::BadMailbox)
    );
    assert_eq!(
        mb.send(&m, Dir::ToPc, &"a".repeat(350_001)).await,
        Err(Error::TooLarge)
    );
}

#[tokio::test]
async fn full_mailbox_refuses_the_501st_message_per_direction() {
    let (_fake, mb, m) = setup().await;
    for _ in 0..500 {
        mb.send(&m, Dir::ToPc, "x").await.unwrap();
    }
    assert_eq!(mb.send(&m, Dir::ToPc, "x").await, Err(Error::Full));
    // The other direction has its own room.
    assert!(mb.send(&m, Dir::ToPhone, "x").await.is_ok());
}

#[tokio::test]
async fn no_internet_is_reported() {
    let mb = Mailbox::with_timeout(
        remote::Config::new("http://127.0.0.1:1", "k"),
        Duration::from_secs(2),
    );
    assert_eq!(mb.seen(&new_mailbox()).await, Err(Error::NoInternet));
}

fn fast() -> Backoff {
    Backoff {
        min: Duration::from_millis(50),
        max: Duration::from_millis(400),
    }
}

async fn until(mut f: impl FnMut() -> bool) {
    timeout(Duration::from_secs(5), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("condition not reached in time");
}

#[tokio::test]
async fn wake_up_arrives_through_the_socket() {
    let (fake, mb, m) = setup().await;
    let notify = Arc::new(Notify::new());
    let l = WakeListener::start_with(
        &fake.config(),
        &m,
        notify.clone(),
        fast(),
        Duration::from_secs(25),
    );
    until(|| l.connected()).await;
    // Drain the notification sent on join.
    let _ = timeout(Duration::from_millis(200), notify.notified()).await;
    mb.send(&m, Dir::ToPc, "hello").await.unwrap();
    timeout(Duration::from_secs(2), notify.notified())
        .await
        .expect("wake-up");
}

#[tokio::test]
async fn socket_reconnects_after_a_drop() {
    let (fake, _mb, m) = setup().await;
    let l = WakeListener::start_with(
        &fake.config(),
        &m,
        Arc::new(Notify::new()),
        fast(),
        Duration::from_secs(25),
    );
    until(|| l.connected()).await;
    fake.kill_sockets();
    until(|| !l.connected()).await;
    until(|| l.connected()).await;
    assert!(fake.joins() >= 2);
}

#[tokio::test]
async fn polling_works_with_realtime_blocked() {
    let (fake, mb, m) = setup().await;
    fake.set_realtime(false);
    let l = WakeListener::start_with(
        &fake.config(),
        &m,
        Arc::new(Notify::new()),
        fast(),
        Duration::from_secs(25),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!l.connected());
    // No wake-up, yet the message is still delivered by polling.
    mb.send(&m, Dir::ToPc, "still arrives (not a sealed body)")
        .await
        .unwrap();
    let mut inbox = Inbox::new(mb, &m, Dir::ToPc);
    assert!(matches!(
        inbox.poll().await.unwrap()[0],
        Incoming::Bad { .. }
    ));
}

#[tokio::test]
async fn at_most_200_new_shops_per_hour() {
    let fake = FakeSupabase::start().await;
    let mb = Mailbox::new(fake.config());
    for _ in 0..200 {
        mb.beat(&new_mailbox(), "s", "n").await.unwrap();
    }
    assert_eq!(
        mb.beat(&new_mailbox(), "s", "n").await,
        Err(Error::TooManyNewShops)
    );
    assert_eq!(fake.shop_count(), 200);
}
