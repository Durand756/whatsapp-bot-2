const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const formidable = require('formidable');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const sharp = require('sharp');
const { exec } = require('child_process');
const { promisify } = require('util');

// Configuration
ffmpeg.setFfmpegPath(ffmpegStatic);
const execAsync = promisify(exec);

const CONFIG = {
    PORT: process.env.PORT || 3000,
    TEMP_DIR: '/tmp/whatsapp-bot',
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    SUPPORTED_AUDIO: ['.mp3', '.wav', '.ogg', '.m4a', '.webm'],
    SUPPORTED_IMAGE: ['.jpg', '.jpeg', '.png', '.webp'],
    SUPPORTED_VIDEO: ['.mp4', '.avi', '.mov', '.webm']
};

// État global
const state = {
    ready: false,
    qr: null,
    client: null,
    server: null,
    users: new Map(), // Stockage des états utilisateurs
    quizzes: new Map() // Stockage des quiz actifs
};

// Initialisation du dossier temporaire
async function initTempDir() {
    try {
        await fs.mkdir(CONFIG.TEMP_DIR, { recursive: true });
        console.log(`📁 Dossier temporaire créé: ${CONFIG.TEMP_DIR}`);
    } catch (error) {
        console.error('❌ Erreur création dossier temp:', error.message);
    }
}

// Utilitaires
function getFileExtension(filename) {
    return path.extname(filename).toLowerCase();
}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
}

// Gestionnaire de fichiers
async function saveFile(buffer, originalName, userId) {
    const ext = getFileExtension(originalName);
    const filename = `${userId}_${Date.now()}_${sanitizeFilename(originalName)}`;
    const filepath = path.join(CONFIG.TEMP_DIR, filename);
    
    await fs.writeFile(filepath, buffer);
    return { filepath, filename, ext };
}

async function cleanupFile(filepath) {
    try {
        await fs.unlink(filepath);
    } catch (error) {
        console.error('❌ Erreur suppression fichier:', error.message);
    }
}

// === COMMANDES ===

// 1. Commande Voice FX
async function voiceFxCommand(client, message, args) {
    try {
        const chat = await message.getChat();
        const userId = message.author || message.from;
        
        if (!message.hasQuotedMsg) {
            return message.reply(`🎤 *Voice FX*

Répondez à un message vocal avec:
/voicefx robot - Voix robotique
/voicefx cartoon - Voix de dessin animé
/voicefx grave - Voix plus grave
/voicefx aigu - Voix plus aiguë
/voicefx echo - Effet d'écho
/voicefx speed - Accélérer la voix

💡 Exemple: Répondez à un vocal puis tapez "/voicefx robot"`);
        }

        const quotedMsg = await message.getQuotedMessage();
        if (!quotedMsg.hasMedia || quotedMsg.type !== 'ptt') {
            return message.reply('❌ Veuillez répondre à un message vocal!');
        }

        const effect = args[0] || 'robot';
        const effects = {
            robot: 'asetrate=44100*0.8,aresample=44100,atempo=1.25',
            cartoon: 'asetrate=44100*1.4,aresample=44100,atempo=0.8',
            grave: 'asetrate=44100*0.6,aresample=44100',
            aigu: 'asetrate=44100*1.6,aresample=44100',
            echo: 'aecho=0.8:0.9:1000:0.3',
            speed: 'atempo=1.5'
        };

        if (!effects[effect]) {
            return message.reply('❌ Effet non reconnu! Utilisez: robot, cartoon, grave, aigu, echo, speed');
        }

        await message.reply('🎵 Application de l\'effet vocal...');

        // Télécharger le fichier audio
        const media = await quotedMsg.downloadMedia();
        const { filepath: inputPath } = await saveFile(Buffer.from(media.data, 'base64'), 'voice.ogg', userId);
        const outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_fx_${Date.now()}.mp3`);

        // Appliquer l'effet avec FFmpeg
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioFilters(effects[effect])
                .audioCodec('libmp3lame')
                .toFormat('mp3')
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        // Envoyer le résultat
        const resultBuffer = await fs.readFile(outputPath);
        const resultMedia = new MessageMedia('audio/mpeg', resultBuffer.toString('base64'), `voicefx_${effect}.mp3`);
        
        await client.sendMessage(chat.id._serialized, resultMedia, {
            caption: `🎤 *Voice FX - ${effect.toUpperCase()}*\n✨ Effet appliqué avec succès!`
        });

        // Nettoyage
        await cleanupFile(inputPath);
        await cleanupFile(outputPath);

    } catch (error) {
        console.error('❌ Erreur Voice FX:', error.message);
        await message.reply('❌ Erreur lors de l\'application de l\'effet vocal');
    }
}

// 2. Commande Stickers
async function stickerCommand(client, message, args) {
    try {
        const chat = await message.getChat();
        const userId = message.author || message.from;
        const signature = args.join(' ') || 'Sticker';

        if (!message.hasQuotedMsg && !message.hasMedia) {
            return message.reply(`🎨 *Créateur de Stickers*

Envoyez une image/vidéo ou répondez à une image/vidéo avec:
/sticker [signature]

💡 Exemple: 
- Envoyez une photo puis "/sticker Mon Nom"
- Ou répondez à une image avec "/sticker @MonCompte"`);
        }

        let media;
        if (message.hasQuotedMsg) {
            const quotedMsg = await message.getQuotedMessage();
            if (!quotedMsg.hasMedia) {
                return message.reply('❌ Le message cité doit contenir une image ou vidéo!');
            }
            media = await quotedMsg.downloadMedia();
        } else if (message.hasMedia) {
            media = await message.downloadMedia();
        }

        const isImage = media.mimetype.startsWith('image/');
        const isVideo = media.mimetype.startsWith('video/');

        if (!isImage && !isVideo) {
            return message.reply('❌ Format non supporté! Utilisez une image ou vidéo.');
        }

        await message.reply('🎨 Création du sticker en cours...');

        // Traitement selon le type
        let outputPath;
        const { filepath: inputPath } = await saveFile(Buffer.from(media.data, 'base64'), 
            isImage ? 'image.jpg' : 'video.mp4', userId);

        if (isImage) {
            // Traitement image
            outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_sticker_${Date.now()}.webp`);
            
            await sharp(inputPath)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 80 })
                .toFile(outputPath);

            // Ajouter signature avec canvas (simulation)
            const stickerBuffer = await fs.readFile(outputPath);
            const stickerMedia = new MessageMedia('image/webp', stickerBuffer.toString('base64'), 'sticker.webp');
            
            await client.sendMessage(chat.id._serialized, stickerMedia, {
                sendMediaAsSticker: true,
                stickerAuthor: signature,
                stickerName: 'Bot Sticker'
            });

        } else {
            // Traitement vidéo (animated sticker)
            outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_sticker_${Date.now()}.webp`);
            
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .size('512x512')
                    .fps(15)
                    .duration(10) // Max 10 secondes
                    .videoCodec('libwebp')
                    .outputOptions(['-loop', '0', '-preset', 'default', '-an'])
                    .on('end', resolve)
                    .on('error', reject)
                    .save(outputPath);
            });

            const stickerBuffer = await fs.readFile(outputPath);
            const stickerMedia = new MessageMedia('image/webp', stickerBuffer.toString('base64'), 'animated_sticker.webp');
            
            await client.sendMessage(chat.id._serialized, stickerMedia, {
                sendMediaAsSticker: true,
                stickerAuthor: signature,
                stickerName: 'Bot Animated Sticker'
            });
        }

        // Nettoyage
        await cleanupFile(inputPath);
        await cleanupFile(outputPath);

    } catch (error) {
        console.error('❌ Erreur Sticker:', error.message);
        await message.reply('❌ Erreur lors de la création du sticker');
    }
}

// 3. Commande Quiz
async function quizCommand(client, message, args) {
    try {
        const userId = message.author || message.from;
        const chat = await message.getChat();
        
        if (args[0] === 'create' || args[0] === 'créer') {
            // Démarrer la création d'un quiz
            state.users.set(userId, { 
                action: 'creating_quiz', 
                step: 'title',
                quiz: { questions: [], title: '', id: generateId() }
            });
            
            return message.reply(`🧠 *Créateur de Quiz*

Étape 1/4: Quel est le titre de votre quiz?
Exemple: "Quel personnage Disney es-tu?"`);
            
        } else if (args[0] === 'answer' || args[0] === 'répondre') {
            // Répondre à un quiz
            const quizId = args[1];
            const answers = args.slice(2).join(' ');
            
            if (!quizId || !answers) {
                return message.reply('❌ Usage: /quiz répondre [ID] [réponses]\nExemple: /quiz répondre ABC123 1a 2b 3c');
            }

            const quiz = state.quizzes.get(quizId);
            if (!quiz) {
                return message.reply('❌ Quiz non trouvé ou expiré!');
            }

            // Analyser les réponses
            const userAnswers = answers.match(/\d+[a-d]/gi) || [];
            let correct = 0;
            let result = `🧠 *Résultats du Quiz: ${quiz.title}*\n\n`;

            quiz.questions.forEach((q, index) => {
                const userAnswer = userAnswers.find(a => a.startsWith((index + 1).toString()));
                const correctAnswer = q.correct;
                
                if (userAnswer && correctAnswer && userAnswer.toLowerCase() === `${index + 1}${correctAnswer}`.toLowerCase()) {
                    correct++;
                    result += `✅ Question ${index + 1}: Correct!\n`;
                } else {
                    result += `❌ Question ${index + 1}: ${correctAnswer ? `Réponse: ${correctAnswer}` : 'Incorrect'}\n`;
                }
            });

            const percentage = Math.round((correct / quiz.questions.length) * 100);
            result += `\n📊 Score: ${correct}/${quiz.questions.length} (${percentage}%)\n`;
            
            if (percentage >= 80) result += `🏆 Excellent! Tu maîtrises le sujet!`;
            else if (percentage >= 60) result += `👍 Bien joué! Pas mal du tout!`;
            else if (percentage >= 40) result += `📚 Il faut réviser un peu plus!`;
            else result += `💪 N'abandonne pas, continue d'apprendre!`;

            return message.reply(result);
        }

        // Menu principal des quiz
        return message.reply(`🧠 *Quiz WhatsApp*

📝 /quiz créer - Créer un nouveau quiz
🎯 /quiz répondre [ID] [réponses] - Répondre à un quiz

💡 *Comment répondre à un quiz:*
Format: /quiz répondre ABC123 1a 2b 3c
(1a = question 1 réponse a, etc.)

🎮 Créez des quiz amusants et défiez vos amis!`);

    } catch (error) {
        console.error('❌ Erreur Quiz:', error.message);
        await message.reply('❌ Erreur lors du traitement du quiz');
    }
}

// Gestionnaire des conversations pour créer un quiz
async function handleQuizCreation(client, message, userState) {
    const userId = message.author || message.from;
    const text = message.body.trim();
    
    try {
        switch (userState.step) {
            case 'title':
                userState.quiz.title = text;
                userState.step = 'question_count';
                return message.reply(`✅ Titre: "${text}"

Étape 2/4: Combien de questions voulez-vous? (1-10)`);

            case 'question_count':
                const count = parseInt(text);
                if (isNaN(count) || count < 1 || count > 10) {
                    return message.reply('❌ Veuillez entrer un nombre entre 1 et 10');
                }
                userState.quiz.questionCount = count;
                userState.quiz.currentQuestion = 1;
                userState.step = 'questions';
                return message.reply(`✅ ${count} question(s)

Étape 3/4: Question 1/${count}
Écrivez votre question:`);

            case 'questions':
                const { quiz, currentQuestion } = userState.quiz;
                const questionIndex = userState.quiz.currentQuestion - 1;
                
                if (!userState.quiz.questions[questionIndex]) {
                    // Nouvelle question
                    userState.quiz.questions[questionIndex] = { question: text, options: [], correct: null };
                    userState.quiz.waitingFor = 'options';
                    return message.reply(`✅ Question: "${text}"

Maintenant, donnez les options de réponse (une par ligne):
a) Option A
b) Option B
c) Option C
d) Option D

Puis tapez "fini" quand terminé`);
                } else if (userState.quiz.waitingFor === 'options') {
                    if (text.toLowerCase() === 'fini') {
                        userState.quiz.waitingFor = 'correct';
                        return message.reply(`✅ Options enregistrées!

Quelle est la bonne réponse? (a, b, c, ou d)
Ou tapez "skip" pour passer sans réponse correcte:`);
                    }
                    
                    // Ajouter option
                    const option = text.replace(/^[a-d]\)\s*/i, '');
                    userState.quiz.questions[questionIndex].options.push(option);
                    return message.reply(`✅ Option ajoutée. Continuez ou tapez "fini"`);
                    
                } else if (userState.quiz.waitingFor === 'correct') {
                    if (text.toLowerCase() !== 'skip') {
                        const correct = text.toLowerCase().match(/[a-d]/);
                        if (correct) {
                            userState.quiz.questions[questionIndex].correct = correct[0];
                        }
                    }
                    
                    // Passer à la question suivante ou terminer
                    userState.quiz.currentQuestion++;
                    if (userState.quiz.currentQuestion <= userState.quiz.questionCount) {
                        userState.quiz.waitingFor = null;
                        return message.reply(`✅ Question ${questionIndex + 1} terminée!

Question ${userState.quiz.currentQuestion}/${userState.quiz.questionCount}:
Écrivez votre question:`);
                    } else {
                        // Quiz terminé
                        userState.step = 'finished';
                        const quizId = userState.quiz.id;
                        state.quizzes.set(quizId, userState.quiz);
                        
                        // Générer le texte du quiz
                        let quizText = `🧠 *${userState.quiz.title}*\n`;
                        quizText += `📝 ID: ${quizId}\n\n`;
                        
                        userState.quiz.questions.forEach((q, index) => {
                            quizText += `${index + 1}. ${q.question}\n`;
                            q.options.forEach((opt, i) => {
                                quizText += `   ${String.fromCharCode(97 + i)}) ${opt}\n`;
                            });
                            quizText += '\n';
                        });
                        
                        quizText += `🎯 *Comment répondre:*\n`;
                        quizText += `/quiz répondre ${quizId} 1a 2b 3c...\n\n`;
                        quizText += `⏰ Quiz actif pendant 24h`;
                        
                        // Nettoyer l'état utilisateur
                        state.users.delete(userId);
                        
                        // Programmer la suppression du quiz après 24h
                        setTimeout(() => {
                            state.quizzes.delete(quizId);
                        }, 24 * 60 * 60 * 1000);
                        
                        return message.reply(`🎉 *Quiz créé avec succès!*\n\n${quizText}`);
                    }
                }
                break;
        }
    } catch (error) {
        console.error('❌ Erreur création quiz:', error.message);
        state.users.delete(userId);
        return message.reply('❌ Erreur lors de la création du quiz. Réessayez avec /quiz créer');
    }
}

// === GESTIONNAIRE PRINCIPAL DES MESSAGES ===
async function handleMessage(message) {
    if (!state.ready || message.fromMe) return;
    
    try {
        const contact = await message.getContact();
        const userId = message.author || message.from;
        const text = message.body.trim();
        const args = text.split(' ').slice(1);
        const cmd = text.split(' ')[0].toLowerCase();

        // Vérifier si l'utilisateur est en cours de création de quiz
        const userState = state.users.get(userId);
        if (userState && userState.action === 'creating_quiz') {
            return handleQuizCreation(state.client, message, userState);
        }

        // Message de bienvenue pour nouveaux utilisateurs
        if (!text.startsWith('/') && !state.users.has(userId)) {
            state.users.set(userId, { welcomed: true, firstSeen: new Date() });
            
            const welcomeMsg = `👋 *Bienvenue ${contact.pushname || 'Utilisateur'}!*

🤖 Je suis votre assistant WhatsApp intelligent!

📋 *Menu Principal:*
🎤 /voicefx - Transformer vos vocaux
🎨 /sticker - Créer des stickers personnalisés  
🧠 /quiz - Créer et jouer aux quiz
❓ /help - Aide complète

✨ Tapez une commande pour commencer!`;

            await message.reply(welcomeMsg);
            return;
        }

        // Traitement des commandes
        switch (cmd) {
            case '/help':
            case '/aide':
                await message.reply(`🤖 *Bot WhatsApp Intelligent*

🎤 *Voice FX* - /voicefx
   Transforme tes vocaux (robot, cartoon, grave, aigu, echo, speed)
   Usage: Réponds à un vocal + /voicefx [effet]

🎨 *Stickers* - /sticker  
   Crée des stickers avec signature
   Usage: Envoie image/vidéo + /sticker [ton nom]

🧠 *Quiz* - /quiz
   Crée des mini-jeux interactifs
   /quiz créer - Nouveau quiz
   /quiz répondre [ID] [réponses] - Jouer

💡 *Astuces:*
• Toutes les fonctions sont gratuites
• Les fichiers sont automatiquement supprimés
• Support: images, vidéos, audios

🚀 Prêt à explorer? Choisis une commande!`);
                break;

            case '/voicefx':
                await voiceFxCommand(state.client, message, args);
                break;

            case '/sticker':
                await stickerCommand(state.client, message, args);
                break;

            case '/quiz':
                await quizCommand(state.client, message, args);
                break;

            case '/stats':
                const stats = {
                    users: state.users.size,
                    quizzes: state.quizzes.size,
                    uptime: Math.floor(process.uptime() / 60)
                };
                await message.reply(`📊 *Statistiques*\n👥 Utilisateurs: ${stats.users}\n🧠 Quiz actifs: ${stats.quizzes}\n⏰ Uptime: ${stats.uptime}min`);
                break;

            default:
                if (text.startsWith('/')) {
                    await message.reply('❌ Commande non reconnue. Tapez /help pour voir toutes les commandes disponibles.');
                }
                break;
        }

    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
        await message.reply('❌ Une erreur s\'est produite. Veuillez réessayer.');
    }
}

// === CLIENT WHATSAPP ===
async function initClient() {
    state.client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    state.client.on('qr', async (qr) => {
        console.log('📱 QR Code généré');
        state.qr = (await QRCode.toDataURL(qr, { width: 400 })).split(',')[1];
        setTimeout(() => { if (!state.ready) state.qr = null; }, 120000);
    });

    state.client.on('authenticated', () => {
        console.log('🔐 Authentifié avec succès');
        state.qr = null;
    });

    state.client.on('ready', () => {
        state.ready = true;
        console.log('🎉 BOT WHATSAPP PRÊT!');
    });

    state.client.on('message', handleMessage);
    
    await state.client.initialize();
}

// === SERVEUR WEB ===
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>👥 ${state.users.size} utilisateurs</p><p>🧠 ${state.quizzes.size} quiz actifs</p><p>🕒 ${new Date().toLocaleString()}</p>` :
        state.qr ? 
        `<h1>📱 Scannez le QR Code</h1><img src="data:image/png;base64,${state.qr}"><p>⏰ Expire dans 2 minutes</p><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Démarrage...</h1><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px;max-width:400px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        uptime: Math.floor(process.uptime()),
        users: state.users.size,
        quizzes: state.quizzes.size
    });
});

// === DÉMARRAGE ===
async function start() {
    console.log('🚀 DÉMARRAGE DU BOT WHATSAPP MODERNE');
    
    await initTempDir();
    
    state.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`🌐 Serveur démarré sur le port ${CONFIG.PORT}`);
    });
    
    await initClient();
}

// Nettoyage automatique toutes les heures
setInterval(async () => {
    try {
        const files = await fs.readdir(CONFIG.TEMP_DIR);
        const now = Date.now();
        
        for (const file of files) {
            const filepath = path.join(CONFIG.TEMP_DIR, file);
            const stats = await fs.stat(filepath);
            
            // Supprimer les fichiers de plus de 1 heure
            if (now - stats.mtime.getTime() > 3600000) {
                await cleanupFile(filepath);
            }
        }
        
        console.log(`🧹 Nettoyage automatique effectué`);
    } catch (error) {
        console.error('❌ Erreur nettoyage:', error.message);
    }
}, 3600000);

// Point d'entrée
if (require.main === module) {
    start().catch(error => {
        console.error('❌ ERREUR FATALE:', error.message);
        process.exit(1);
    });
}

module.exports = { start, state, CONFIG };
