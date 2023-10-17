const {
  default: makeWASocket,
  MessageType,
  MessageOptions,
  Mimetype,
  DisconnectReason,
  BufferJSON,
  AnyMessageContent,
  delay,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  MessageRetryMap,
  useMultiFileAuthState,
  msgRetryCounterMap,
} = require("@whiskeysockets/baileys");

const log = (pino = require("pino"));
const { session } = { session: "session_auth_info" };
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();
// enable files upload
app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 8000;
const qrcode = require("qrcode");

app.use("/assets", express.static(__dirname + "/client/assets"));

app.get("/scan", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});

app.get("/", (req, res) => {
  res.send("server working");
});

let sock;
let qrDinamic;
let soket;

let messageArray = []; 

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("session_auth_info");

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: log({ level: "silent" }),
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    qrDinamic = qr;
    if (connection === "close") {
      let reason = new Boom(lastDisconnect.error).output.statusCode;
      if (reason === DisconnectReason.badSession) {
        console.log(
          `Kötü Oturum Dosyası, Lütfen ${session} dosyasını silin ve tekrar tarayın`
        );
        sock.logout();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("Bağlantı kapandı, yeniden bağlanıyor....");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("Sunucudan bağlantı kayboldu, yeniden bağlanıyor...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Bağlantı değiştirildi, başka bir oturum açıldı, önce mevcut oturumu kapatın"
        );
        sock.logout();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(
          `Cihaz oturumu kapattı, ${session} dosyasını silin ve tekrar tarayın.`
        );
        sock.logout();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("Yeniden başlatma gerekiyor, yeniden başlatılıyor...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("Bağlantı zaman aşımına uğradı, yeniden bağlanıyor...");
        connectToWhatsApp();
      } else {
        sock.end(
          `Bilinmeyen bağlantı kesme nedeni: ${reason}|${lastDisconnect.error}`
        );
      }
    } else if (connection === "open") {
      console.log("Bağlantı açık");
      return;
    }
  });
  
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type === "notify") {
        messages.forEach(async msg => { 
          let sender;
          const captureMessage = msg?.message?.conversation;
          const remoteJid = msg?.key?.remoteJid;
          
          if (remoteJid.endsWith('@g.us')) { // Eğer mesaj bir gruptan geldiyse
            const groupInfo = await sock.groupMetadata(remoteJid); // Grup bilgilerini al
            sender = groupInfo?.subject || remoteJid; // Grup adını veya JID'sini kullan

            messageArray.push({
              sender: sender,
              message: captureMessage,
            }); // Sadece grup mesajlarını messageArray'e ekle
          }
        });
      }
    } catch (error) {
      console.log("error ", error);
    }
});


  sock.ev.on("creds.update", saveCreds);
}

const isConnected = () => {
  return sock?.user ? true : false;
};

// grup mesajlarını döndürür
app.get("/get-messages", (req, res) => {
  if(isConnected()) {
    res.status(200).json({
    status: true,
    messages: messageArray,
  });

  const filePath = path.join(__dirname, 'messages.txt');
  fs.writeFileSync(filePath, JSON.stringify(messageArray, null, 2));
  }
  
});

// katılımcılarla birlikte grup oluşturma 
app.post("/create-group-and-add-participants", async (req, res) => {
  try {
    const { phoneNumbers, groupName } = req.body; 

    if (!phoneNumbers || !Array.isArray(phoneNumbers) || !groupName) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    const group = await sock.groupCreate(groupName, phoneNumbers.map(num => `${num}@s.whatsapp.net`));

    console.log('group: ',group)

    if (!group || !group.id) {
      return res.status(500).json({ status: false, message: "Grup oluşturulamadı" });
    }

    await sock.groupSettingUpdate(group.id, 'announcement'); // sadece yöneticiler mesaj atabilir ayarı

    return res.status(200).json({ status: true, message: "Grup başarıyla oluşturuldu ve katılımcılar eklendi", groupId: group.id });
  } catch (error) {
    console.log("Hata: ", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});

// var olan gruba katılımcı ekleme
app.post("/add-participants-to-group", async (req, res) => {
  try {
    let { phoneNumbers, groupId } = req.body;
    let newGroupId = groupId + '@g.us';
    console.log(groupId)
    if (!phoneNumbers || !Array.isArray(phoneNumbers) || !newGroupId || !newGroupId.endsWith('@g.us')) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    const formattedNumbers = phoneNumbers.map(num => `${num}@s.whatsapp.net`);
    const response = await sock.groupParticipantsUpdate(newGroupId, formattedNumbers, "add");
    const errors = response.filter(r => r.status !== '200'); 

    if(errors.length > 0) {
      console.log("Katılımcı eklenirken hatalar:", errors);
      return res.status(500).json({ status: false, errors });
    }

    return res.status(200).json({ status: true, message: "Katılımcılar başarıyla eklendi" });
  } catch (error) {
    console.log("Hata:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});

// katılımcı şutlama
app.post("/remove-participants", async (req, res) => {
  try {
    const { phoneNumbers, groupId } = req.body;

    if (!phoneNumbers || !Array.isArray(phoneNumbers) || !groupId) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    const formattedNumbers = phoneNumbers.map(num => `${num}@s.whatsapp.net`);

    // Katılımcıları gruptan çıkar
    await sock.groupParticipantsUpdate(
      `${groupId}@g.us`,
      formattedNumbers,
      "remove"
    );

    return res.status(200).json({ status: true, message: "Katılımcı veya katılımcılar gruptan şutlandı!" });
  } catch (error) {
    console.log("Error:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});


// katılımcıları yönetici yapar
app.post("/promote-participants", async (req, res) => {
  try {
    const { phoneNumbers, groupId } = req.body;

    if (!phoneNumbers || !Array.isArray(phoneNumbers) || !groupId) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    const formattedNumbers = phoneNumbers.map(num => `${num}@s.whatsapp.net`);

    await sock.groupParticipantsUpdate(
      `${groupId}@g.us`,
      formattedNumbers,
      "promote" 
    );

    return res.status(200).json({ status: true, message: "Katılımcılar başarıyla yönetici yapıldı" });
  } catch (error) {
    console.log("Hata:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});

// grup konusunu güncelleme
app.post("/update-group-subject", async (req, res) => {
  try {
    const { groupId, newSubject } = req.body;

    if (!groupId || !newSubject) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    await sock.groupUpdateSubject(`${groupId}@g.us`, newSubject);
    return res.status(200).json({ status: true, message: "Grup konusu başarıyla güncellendi!" });
  } catch (error) {
    console.log("Error:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});

// grup açıklamasını güncelleme
app.post("/update-group-description", async (req, res) => {
  try {
    const { groupId, newDescription } = req.body;

    if (!groupId || !newDescription) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    await sock.groupUpdateDescription(`${groupId}@g.us`, newDescription);
    return res.status(200).json({ status: true, message: "Grup açıklaması başarıyla güncellendi!" });
  } catch (error) {
    console.log("Error:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});

// gruba davet etme mesajı gönderme
app.post("/invite-to-group", async (req, res) => {
  try {
    const { phoneNumbers, groupId, messageText } = req.body;

    if (!Array.isArray(phoneNumbers) || !phoneNumbers.length || !groupId || !messageText) {
      return res.status(400).json({ status: false, message: "Geçersiz parametreler" });
    }

    if (!isConnected()) {
      return res.status(500).json({ status: false, message: "WhatsApp'a bağlı değil" });
    }

    const code = await sock.groupInviteCode(`${groupId}@g.us`);
    const inviteLink = `https://chat.whatsapp.com/${code}`;

    const promises = phoneNumbers.map(async (number) => {
      const formattedNumber = `${number}@s.whatsapp.net`;
      const inviteMessage = `${messageText} bu davet linkiyle katılabilirsin: ${inviteLink}`;
      return sock.sendMessage(formattedNumber, { text: inviteMessage });
    });

    await Promise.all(promises);
    return res.status(200).json({ status: true, message: "Davet mesajları gönderildi!" });
  } catch (error) {
    console.log("Error:", error);
    return res.status(500).json({ status: false, message: "Bir hata oluştu" });
  }
});


// numaraya mesaj gönderme 
app.post("/send-message", async (req, res) => {
  const tempMessage = req.body.message;
  const number = req.body.number;

  let numberWA;
  try {
    if (!number) {
      res.status(500).json({
        status: false,
        response: "Numara mevcut değil",
      });
    } else {
      numberWA = number + "@s.whatsapp.net";
   
      if (isConnected()) {
        const exist = await sock.onWhatsApp(numberWA);
        if (exist?.jid || (exist && exist[0]?.jid)) {
          sock
            .sendMessage(exist.jid || exist[0].jid, {
              text: tempMessage,
            })
            .then((result) => {
              res.status(200).json({
                status: true,
                response: result,
              });
            })
            .catch((err) => {
              res.status(500).json({
                status: false,
                response: err,
              });
            });
        }
      } else {
        res.status(500).json({
          status: false,
          response: "Henüz bağlı değilsiniz",
        });
      }
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

io.on("connection", async (socket) => {
  soket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrDinamic) {
    updateQR("qr");
  }
});

const updateQR = (data) => {
  switch (data) {
    case "qr":
      qrcode.toDataURL(qrDinamic, (err, url) => {
        soket?.emit("qr", url);
        soket?.emit("log", "QR alındı, tarayın");
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", "Kullanıcı bağlı");
      const { id, name } = sock?.user;
      var userinfo = id + " " + name;
      soket?.emit("user", userinfo);

      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Yükleniyor ....");

      break;
    default:
      break;
  }
};

connectToWhatsApp().catch((err) => console.log("hata: " + err));
server.listen(port, () => {
  console.log("Sunucu " + port + " portunda çalışıyor");
});
