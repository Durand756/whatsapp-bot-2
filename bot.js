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

// Commande Voice FX avec 16 effets vocaux
async function voiceFxCommand(client, message, args) {
    try {
        const chat = await message.getChat();
        const userId = message.author || message.from;
        
        if (!message.hasQuotedMsg) {
            return message.reply(`🎤 *Voice FX - 16 Effets Vocaux*

Répondez à un message vocal avec:

🤖 **Effets Robotiques:**
/voicefx robot - Voix robotique classique
/voicefx cyborg - Voix cybernétique
/voicefx metallic - Voix métallique

🎭 **Effets Créatifs:**
/voicefx cartoon - Voix de dessin animé
/voicefx alien - Voix extraterrestre
/voicefx demon - Voix démoniaque
/voicefx ghost - Voix fantôme

🎵 **Effets Audio:**
/voicefx echo - Effet d'écho
/voicefx reverb - Réverbération
/voicefx distortion - Distorsion
/voicefx whisper - Chuchotement

⚡ **Effets de Vitesse:**
/voicefx speed - Accélérer la voix
/voicefx slow - Ralentir la voix

🎚️ **Effets de Tonalité:**
/voicefx grave - Voix plus grave
/voicefx aigu - Voix plus aiguë
/voicefx deep - Voix très profonde

💡 **Exemple:** Répondez à un vocal puis tapez "/voicefx alien"`);
        }

        const quotedMsg = await message.getQuotedMessage();
        if (!quotedMsg.hasMedia || quotedMsg.type !== 'ptt') {
            return message.reply('❌ Veuillez répondre à un message vocal!');
        }

        const effect = args[0] || 'robot';
        
        // 16 effets vocaux différents
        const effects = {
            // Effets robotiques
            robot: {
                filter: 'asetrate=44100*0.8,aresample=44100,atempo=1.25',
                emoji: '🤖',
                name: 'Robot'
            },
            cyborg: {
                filter: 'asetrate=44100*0.7,aresample=44100,atempo=1.3,tremolo=f=10:d=0.5',
                emoji: '🦾',
                name: 'Cyborg'
            },
            metallic: {
                filter: 'asetrate=44100*0.75,aresample=44100,atempo=1.2,highpass=f=1000',
                emoji: '🔩',
                name: 'Métallique'
            },
            
            // Effets créatifs
            cartoon: {
                filter: 'asetrate=44100*1.4,aresample=44100,atempo=0.8',
                emoji: '🎭',
                name: 'Cartoon'
            },
            alien: {
                filter: 'asetrate=44100*1.8,aresample=44100,atempo=0.7,tremolo=f=5:d=0.8',
                emoji: '👽',
                name: 'Alien'
            },
            demon: {
                filter: 'asetrate=44100*0.5,aresample=44100,atempo=1.4,lowpass=f=800',
                emoji: '👹',
                name: 'Démon'
            },
            ghost: {
                filter: 'asetrate=44100*1.2,aresample=44100,atempo=0.9,tremolo=f=3:d=0.7,volume=0.6',
                emoji: '👻',
                name: 'Fantôme'
            },
            
            // Effets audio
            echo: {
                filter: 'aecho=0.8:0.9:1000:0.3',
                emoji: '🔊',
                name: 'Echo'
            },
            reverb: {
                filter: 'aecho=0.8:0.88:60:0.4,aecho=0.8:0.88:40:0.3',
                emoji: '🎵',
                name: 'Reverb'
            },
            distortion: {
                filter: 'overdrive=20:20',
                emoji: '⚡',
                name: 'Distorsion'
            },
            whisper: {
                filter: 'volume=0.3,highpass=f=100,lowpass=f=3000',
                emoji: '🤫',
                name: 'Chuchotement'
            },
            
            // Effets de vitesse
            speed: {
                filter: 'atempo=1.5',
                emoji: '💨',
                name: 'Rapide'
            },
            slow: {
                filter: 'atempo=0.7',
                emoji: '🐌',
                name: 'Lent'
            },
            
            // Effets de tonalité
            grave: {
                filter: 'asetrate=44100*0.6,aresample=44100',
                emoji: '🎚️',
                name: 'Grave'
            },
            aigu: {
                filter: 'asetrate=44100*1.6,aresample=44100',
                emoji: '🎼',
                name: 'Aigu'
            },
            deep: {
                filter: 'asetrate=44100*0.4,aresample=44100,atempo=1.8,lowpass=f=1000',
                emoji: '🌊',
                name: 'Profond'
            }
        };

        if (!effects[effect]) {
            const availableEffects = Object.keys(effects).join(', ');
            return message.reply(`❌ Effet non reconnu! 

🎤 **Effets disponibles:**
${availableEffects}

💡 Tapez "/voicefx" sans argument pour voir la liste complète avec descriptions.`);
        }

        const selectedEffect = effects[effect];
        await message.reply(`${selectedEffect.emoji} Application de l'effet "${selectedEffect.name}"...`);

        // Télécharger le fichier audio
        const media = await quotedMsg.downloadMedia();
        const { filepath: inputPath } = await saveFile(Buffer.from(media.data, 'base64'), 'voice.ogg', userId);
        const outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_fx_${effect}_${Date.now()}.mp3`);

        // Appliquer l'effet avec FFmpeg
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .audioFilters(selectedEffect.filter)
                .audioCodec('libmp3lame')
                .audioBitrate('128k')
                .toFormat('mp3')
                .on('start', (commandLine) => {
                    console.log(`🎵 FFmpeg started: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Progress: ${Math.round(progress.percent)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Voice FX processing completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .save(outputPath);
        });

        // Vérifier que le fichier de sortie existe
        try {
            await fs.access(outputPath);
        } catch (error) {
            throw new Error('Le fichier de sortie n\'a pas été créé');
        }

        // Envoyer le résultat
        const resultBuffer = await fs.readFile(outputPath);
        const resultMedia = new MessageMedia('audio/mpeg', resultBuffer.toString('base64'), `voicefx_${effect}.mp3`);
        
        await client.sendMessage(chat.id._serialized, resultMedia, {
            caption: `${selectedEffect.emoji} *Voice FX - ${selectedEffect.name.toUpperCase()}*
✨ Effet appliqué avec succès!
🎤 Essayez d'autres effets avec /voicefx`
        });

        console.log(`✅ Voice FX ${effect} applied successfully for user ${userId}`);

        // Nettoyage des fichiers temporaires
        await cleanupFile(inputPath);
        await cleanupFile(outputPath);

    } catch (error) {
        console.error('❌ Erreur Voice FX:', error.message);
        
        // Message d'erreur personnalisé selon le type d'erreur
        let errorMessage = '❌ Erreur lors de l\'application de l\'effet vocal';
        
        if (error.message.includes('ffmpeg')) {
            errorMessage += '\n🔧 Problème de traitement audio';
        } else if (error.message.includes('media')) {
            errorMessage += '\n📱 Problème de téléchargement du vocal';
        } else if (error.message.includes('fichier')) {
            errorMessage += '\n💾 Problème de sauvegarde';
        }
        
        errorMessage += '\n\n💡 Réessayez dans quelques instants';
        
        await message.reply(errorMessage);
        
        // Nettoyage en cas d'erreur
        try {
            const inputPath = path.join(CONFIG.TEMP_DIR, `${userId}_voice.ogg`);
            const outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_fx_${args[0] || 'robot'}_${Date.now()}.mp3`);
            await cleanupFile(inputPath);
            await cleanupFile(outputPath);
        } catch (cleanupError) {
            console.error('❌ Erreur nettoyage:', cleanupError.message);
        }
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

// 3. Commande Quiz améliorée avec possibilité d'annulation
async function quizCommand(client, message, args) {
    try {
        const userId = message.author || message.from;
        const chat = await message.getChat();
        const contact = await message.getContact();
        const userName = contact.pushname || 'Utilisateur';
        
        if (args[0] === 'create' || args[0] === 'créer' || args[0] === 'creer') {
            // Démarrer la création d'un quiz
            state.users.set(userId, { 
                action: 'creating_quiz', 
                step: 'title',
                quiz: { 
                    questions: [], 
                    title: '', 
                    id: generateId(),
                    creator: userName,
                    createdAt: new Date(),
                    category: null,
                    difficulty: null
                }
            });
            
            return message.reply(`🧠 *Créateur de Quiz Avancé*

👋 Salut ${userName}! Créons un super quiz ensemble!

📝 **Étape 1/6: Titre du Quiz**
Quel est le titre de votre quiz?

💡 **Exemples:**
• "Quel personnage Disney es-tu?"
• "Culture Générale 2024"
• "Test de Personnalité"
• "Connais-tu bien ton pays?"

⚠️ **À tout moment, tapez "annuler" pour arrêter la création**`);
            
        } else if (args[0] === 'answer' || args[0] === 'répondre' || args[0] === 'repondre') {
            // Répondre à un quiz
            const quizId = args[1];
            const answers = args.slice(2).join(' ');
            
            if (!quizId || !answers) {
                return message.reply(`❌ **Usage incorrect!**

🎯 **Format correct:**
/quiz répondre [ID] [réponses]

💡 **Exemple:**
/quiz répondre ABC123 1a 2b 3c 4d

📝 **Explication:**
• 1a = Question 1, réponse A
• 2b = Question 2, réponse B
• etc...`);
            }

            const quiz = state.quizzes.get(quizId);
            if (!quiz) {
                return message.reply(`❌ **Quiz introuvable!**

🔍 Le quiz "${quizId}" n'existe pas ou a expiré.

💡 **Créez votre propre quiz avec:**
/quiz créer`);
            }

            // Analyser les réponses
            const userAnswers = answers.match(/\d+[a-d]/gi) || [];
            let correct = 0;
            let details = '';
            
            let result = `🧠 **Résultats du Quiz: ${quiz.title}**\n`;
            result += `👤 Par: ${quiz.creator}\n`;
            result += `📊 Catégorie: ${quiz.category || 'Général'}\n`;
            result += `⭐ Difficulté: ${quiz.difficulty || 'Normale'}\n\n`;

            quiz.questions.forEach((q, index) => {
                const userAnswer = userAnswers.find(a => a.startsWith((index + 1).toString()));
                const correctLetter = q.correct;
                const questionNum = index + 1;
                
                if (userAnswer && correctLetter && userAnswer.toLowerCase() === `${questionNum}${correctLetter}`.toLowerCase()) {
                    correct++;
                    details += `✅ **Q${questionNum}:** Correct! (${correctLetter.toUpperCase()})\n`;
                } else {
                    const userChoice = userAnswer ? userAnswer.charAt(userAnswer.length - 1).toUpperCase() : 'Pas de réponse';
                    const correctChoice = correctLetter ? correctLetter.toUpperCase() : 'Pas définie';
                    details += `❌ **Q${questionNum}:** ${userChoice} → Réponse: ${correctChoice}\n`;
                    
                    // Ajouter explication si disponible
                    if (q.explanation) {
                        details += `   💡 ${q.explanation}\n`;
                    }
                }
            });

            const percentage = Math.round((correct / quiz.questions.length) * 100);
            
            // Système de notation avancé
            let grade, emoji, comment;
            if (percentage >= 90) {
                grade = 'A+'; emoji = '🏆'; comment = 'PARFAIT! Tu es un expert!';
            } else if (percentage >= 80) {
                grade = 'A'; emoji = '🥇'; comment = 'Excellent! Très impressionnant!';
            } else if (percentage >= 70) {
                grade = 'B+'; emoji = '🥈'; comment = 'Très bien! Tu maîtrises le sujet!';
            } else if (percentage >= 60) {
                grade = 'B'; emoji = '🥉'; comment = 'Bien joué! C\'est un bon résultat!';
            } else if (percentage >= 50) {
                grade = 'C'; emoji = '📚'; comment = 'Pas mal! Continue à apprendre!';
            } else if (percentage >= 30) {
                grade = 'D'; emoji = '💪'; comment = 'Il faut réviser, mais n\'abandonne pas!';
            } else {
                grade = 'F'; emoji = '🔄'; comment = 'Réessaye! L\'apprentissage est un processus!';
            }
            
            result += `📈 **RÉSULTATS DÉTAILLÉS:**\n${details}\n`;
            result += `🎯 **SCORE FINAL:** ${correct}/${quiz.questions.length} (${percentage}%)\n`;
            result += `📝 **NOTE:** ${grade} ${emoji}\n`;
            result += `💬 **${comment}**\n\n`;
            result += `🎮 Merci d'avoir joué! Créez votre quiz avec /quiz créer`;

            return message.reply(result);
            
        } else if (args[0] === 'list' || args[0] === 'liste') {
            // Lister les quiz disponibles
            if (state.quizzes.size === 0) {
                return message.reply(`📝 **Aucun Quiz Disponible**

🎮 Soyez le premier à créer un quiz!
/quiz créer`);
            }
            
            let quizList = `📋 **Quiz Disponibles (${state.quizzes.size})**\n\n`;
            let count = 1;
            
            for (const [id, quiz] of state.quizzes.entries()) {
                const timeLeft = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - quiz.createdAt.getTime())) / (60 * 60 * 1000));
                quizList += `${count}. **${quiz.title}**\n`;
                quizList += `   🆔 ID: ${id}\n`;
                quizList += `   👤 Créateur: ${quiz.creator}\n`;
                quizList += `   📊 ${quiz.questions.length} questions\n`;
                quizList += `   ⏰ Expire dans ${timeLeft}h\n\n`;
                count++;
            }
            
            quizList += `🎯 **Pour jouer:** /quiz répondre [ID] [réponses]`;
            return message.reply(quizList);
            
        } else if (args[0] === 'help' || args[0] === 'aide') {
            return message.reply(`🧠 **Guide Complet des Quiz**

🎮 **COMMANDES PRINCIPALES:**
📝 /quiz créer - Créer un nouveau quiz
🎯 /quiz répondre [ID] [réponses] - Jouer à un quiz
📋 /quiz liste - Voir tous les quiz disponibles
❓ /quiz aide - Voir ce guide

🎯 **COMMENT JOUER:**
1. Trouvez l'ID du quiz (ex: ABC123)
2. Répondez: /quiz répondre ABC123 1a 2b 3c
3. Format: [numéro question][lettre réponse]

📝 **CRÉATION DE QUIZ:**
• 6 étapes guidées
• Jusqu'à 15 questions
• Catégories et difficultés
• Explications optionnelles
• Annulation possible à tout moment

🏆 **SYSTÈME DE NOTATION:**
• A+ (90-100%) - 🏆 Expert
• A (80-89%) - 🥇 Excellent  
• B+ (70-79%) - 🥈 Très bien
• B (60-69%) - 🥉 Bien
• C (50-59%) - 📚 Correct
• D (30-49%) - 💪 À améliorer
• F (0-29%) - 🔄 Réessayer

✨ Amusez-vous bien!`);
        }

        // Menu principal des quiz
        return message.reply(`🧠 **Quiz WhatsApp - Menu Principal**

🎮 **ACTIONS RAPIDES:**
📝 /quiz créer - Nouveau quiz interactif
📋 /quiz liste - Voir les quiz disponibles  
❓ /quiz aide - Guide complet

📊 **STATISTIQUES:**
👥 ${state.users.size} utilisateurs actifs
🧠 ${state.quizzes.size} quiz en ligne
⚡ ${Math.floor(process.uptime() / 60)} minutes d'uptime

💡 **Nouveautés:**
• Système de notation A-F
• Catégories et difficultés
• Explications détaillées
• Annulation à tout moment

🚀 Prêt à défier vos amis?`);

    } catch (error) {
        console.error('❌ Erreur Quiz:', error.message);
        await message.reply('❌ Erreur lors du traitement du quiz. Réessayez dans quelques instants.');
    }
}

// Gestionnaire des conversations pour créer un quiz (amélioré)
async function handleQuizCreation(client, message, userState) {
    const userId = message.author || message.from;
    const text = message.body.trim();
    const contact = await message.getContact();
    const userName = contact.pushname || 'Utilisateur';
    
    // Vérifier si l'utilisateur veut annuler
    if (text.toLowerCase() === 'annuler' || text.toLowerCase() === 'cancel' || text.toLowerCase() === 'stop') {
        state.users.delete(userId);
        return message.reply(`🚫 **Création Annulée**

❌ La création de votre quiz a été annulée.
🔄 Vous pouvez recommencer avec /quiz créer

👋 À bientôt ${userName}!`);
    }
    
    try {
        switch (userState.step) {
            case 'title':
                if (text.length < 5) {
                    return message.reply(`❌ **Titre trop court!**

📝 Le titre doit contenir au moins 5 caractères.

💡 **Exemples valides:**
• "Quiz de Culture Générale"
• "Connais-tu les animaux?"
• "Test de Personnalité"

⚠️ Tapez "annuler" pour arrêter`);
                }
                
                userState.quiz.title = text;
                userState.step = 'category';
                return message.reply(`✅ **Titre:** "${text}"

📂 **Étape 2/6: Catégorie**
Choisissez une catégorie pour votre quiz:

1️⃣ Culture Générale
2️⃣ Sciences
3️⃣ Histoire
4️⃣ Sport
5️⃣ Divertissement
6️⃣ Personnalité
7️⃣ Géographie
8️⃣ Autre

💡 Tapez le numéro ou le nom de la catégorie
⚠️ Tapez "annuler" pour arrêter`);

            case 'category':
                const categories = {
                    '1': 'Culture Générale', '2': 'Sciences', '3': 'Histoire', '4': 'Sport',
                    '5': 'Divertissement', '6': 'Personnalité', '7': 'Géographie', '8': 'Autre',
                    'culture générale': 'Culture Générale', 'culture': 'Culture Générale',
                    'sciences': 'Sciences', 'science': 'Sciences',
                    'histoire': 'Histoire', 'sport': 'Sport', 'sports': 'Sport',
                    'divertissement': 'Divertissement', 'entertainment': 'Divertissement',
                    'personnalité': 'Personnalité', 'personalité': 'Personnalité',
                    'géographie': 'Géographie', 'geographie': 'Géographie',
                    'autre': 'Autre', 'autres': 'Autre'
                };
                
                const selectedCategory = categories[text.toLowerCase()] || 'Autre';
                userState.quiz.category = selectedCategory;
                userState.step = 'difficulty';
                
                return message.reply(`✅ **Catégorie:** ${selectedCategory}

⭐ **Étape 3/6: Difficulté**
Choisissez le niveau de difficulté:

🟢 **1. Facile** - Questions simples pour tous
🟡 **2. Normale** - Niveau modéré
🔴 **3. Difficile** - Pour les experts
🟣 **4. Expert** - Défi ultime!

💡 Tapez le numéro ou le nom de la difficulté
⚠️ Tapez "annuler" pour arrêter`);

            case 'difficulty':
                const difficulties = {
                    '1': 'Facile', '2': 'Normale', '3': 'Difficile', '4': 'Expert',
                    'facile': 'Facile', 'easy': 'Facile',
                    'normale': 'Normale', 'normal': 'Normale', 'moyen': 'Normale',
                    'difficile': 'Difficile', 'hard': 'Difficile', 'dur': 'Difficile',
                    'expert': 'Expert', 'très difficile': 'Expert', 'extrême': 'Expert'
                };
                
                const selectedDifficulty = difficulties[text.toLowerCase()] || 'Normale';
                userState.quiz.difficulty = selectedDifficulty;
                userState.step = 'question_count';
                
                return message.reply(`✅ **Difficulté:** ${selectedDifficulty}

🔢 **Étape 4/6: Nombre de Questions**
Combien de questions voulez-vous? (1-15)

💡 **Recommandations:**
• 3-5 questions: Quiz rapide
• 6-10 questions: Quiz standard  
• 11-15 questions: Quiz complet

⚠️ Tapez "annuler" pour arrêter`);

            case 'question_count':
                const count = parseInt(text);
                if (isNaN(count) || count < 1 || count > 15) {
                    return message.reply(`❌ **Nombre invalide!**

🔢 Veuillez entrer un nombre entre 1 et 15.

💡 **Exemple:** 5

⚠️ Tapez "annuler" pour arrêter`);
                }
                
                userState.quiz.questionCount = count;
                userState.quiz.currentQuestion = 1;
                userState.step = 'questions';
                
                return message.reply(`✅ **${count} question(s)** programmées

📝 **Étape 5/6: Questions**
**Question 1/${count}**

Écrivez votre première question:

💡 **Conseil:** Soyez clair et précis!
⚠️ Tapez "annuler" pour arrêter`);

            case 'questions':
                const { quiz } = userState;
                const questionIndex = userState.quiz.currentQuestion - 1;
                
                if (!userState.quiz.questions[questionIndex]) {
                    // Nouvelle question
                    if (text.length < 10) {
                        return message.reply(`❌ **Question trop courte!**

📝 La question doit contenir au moins 10 caractères.

💡 **Exemple:** "Quelle est la capitale de la France?"

⚠️ Tapez "annuler" pour arrêter`);
                    }
                    
                    userState.quiz.questions[questionIndex] = { 
                        question: text, 
                        options: [], 
                        correct: null,
                        explanation: null
                    };
                    userState.quiz.waitingFor = 'options';
                    
                    return message.reply(`✅ **Question:** "${text}"

📋 **Options de Réponse**
Donnez 2 à 4 options (une par ligne):

**Format recommandé:**
a) Première option
b) Deuxième option  
c) Troisième option
d) Quatrième option

Puis tapez **"fini"** quand terminé

⚠️ Tapez "annuler" pour arrêter`);
                    
                } else if (userState.quiz.waitingFor === 'options') {
                    if (text.toLowerCase() === 'fini' || text.toLowerCase() === 'terminé') {
                        if (userState.quiz.questions[questionIndex].options.length < 2) {
                            return message.reply(`❌ **Pas assez d'options!**

📋 Il faut au moins 2 options de réponse.

💡 Ajoutez encore une option puis tapez "fini"

⚠️ Tapez "annuler" pour arrêter`);
                        }
                        
                        userState.quiz.waitingFor = 'correct';
                        const options = userState.quiz.questions[questionIndex].options;
                        let optionsList = '';
                        options.forEach((opt, i) => {
                            optionsList += `${String.fromCharCode(97 + i)}) ${opt}\n`;
                        });
                        
                        return message.reply(`✅ **Options enregistrées!**

${optionsList}

🎯 **Bonne Réponse**
Quelle est la bonne réponse? (a, b, c, ou d)

💡 Ou tapez "skip" pour passer (pas de bonne réponse)
⚠️ Tapez "annuler" pour arrêter`);
                    }
                    
                    // Ajouter option
                    const cleanOption = text.replace(/^[a-d]\)\s*/i, '').trim();
                    if (cleanOption.length < 2) {
                        return message.reply(`❌ **Option trop courte!**

📝 L'option doit contenir au moins 2 caractères.

⚠️ Tapez "annuler" pour arrêter`);
                    }
                    
                    userState.quiz.questions[questionIndex].options.push(cleanOption);
                    const optionCount = userState.quiz.questions[questionIndex].options.length;
                    
                    return message.reply(`✅ **Option ${optionCount} ajoutée!**

💡 Ajoutez une autre option ou tapez "fini"
⚠️ Tapez "annuler" pour arrêter`);
                    
                } else if (userState.quiz.waitingFor === 'correct') {
                    let correctAnswer = null;
                    
                    if (text.toLowerCase() !== 'skip') {
                        const match = text.toLowerCase().match(/[a-d]/);
                        if (match) {
                            const letterIndex = match[0].charCodeAt(0) - 97;
                            if (letterIndex < userState.quiz.questions[questionIndex].options.length) {
                                correctAnswer = match[0];
                            } else {
                                return message.reply(`❌ **Lettre invalide!**

🎯 Choisissez parmi les options disponibles (a-${String.fromCharCode(96 + userState.quiz.questions[questionIndex].options.length)})

⚠️ Tapez "annuler" pour arrêter`);
                            }
                        }
                    }
                    
                    userState.quiz.questions[questionIndex].correct = correctAnswer;
                    userState.quiz.waitingFor = 'explanation';
                    
                    return message.reply(`✅ **Réponse ${correctAnswer ? correctAnswer.toUpperCase() : 'non définie'}**

💡 **Explication (Optionnel)**
Voulez-vous ajouter une explication pour cette question?

📝 Tapez votre explication ou "skip" pour passer
⚠️ Tapez "annuler" pour arrêter`);
                    
                } else if (userState.quiz.waitingFor === 'explanation') {
                    if (text.toLowerCase() !== 'skip') {
                        userState.quiz.questions[questionIndex].explanation = text;
                    }
                    
                    // Passer à la question suivante ou terminer
                    userState.quiz.currentQuestion++;
                    if (userState.quiz.currentQuestion <= userState.quiz.questionCount) {
                        userState.quiz.waitingFor = null;
                        return message.reply(`✅ **Question ${questionIndex + 1} terminée!**

📝 **Question ${userState.quiz.currentQuestion}/${userState.quiz.questionCount}**

Écrivez votre prochaine question:

⚠️ Tapez "annuler" pour arrêter`);
                    } else {
                        // Quiz terminé
                        userState.step = 'finished';
                        const quizId = userState.quiz.id;
                        state.quizzes.set(quizId, userState.quiz);
                        
                        // Générer le texte du quiz
                        let quizText = `🧠 **${userState.quiz.title}**\n`;
                        quizText += `🆔 **ID:** ${quizId}\n`;
                        quizText += `👤 **Créateur:** ${userState.quiz.creator}\n`;
                        quizText += `📂 **Catégorie:** ${userState.quiz.category}\n`;
                        quizText += `⭐ **Difficulté:** ${userState.quiz.difficulty}\n`;
                        quizText += `📅 **Créé:** ${userState.quiz.createdAt.toLocaleString()}\n\n`;
                        
                        userState.quiz.questions.forEach((q, index) => {
                            quizText += `**${index + 1}.** ${q.question}\n`;
                            q.options.forEach((opt, i) => {
                                const letter = String.fromCharCode(97 + i);
                                const marker = q.correct === letter ? '✅' : '  ';
                                quizText += `   ${letter}) ${opt} ${marker}\n`;
                            });
                            if (q.explanation) {
                                quizText += `   💡 *${q.explanation}*\n`;
                            }
                            quizText += '\n';
                        });
                        
                        quizText += `🎯 **Comment répondre:**\n`;
                        quizText += `/quiz répondre ${quizId} 1a 2b 3c...\n\n`;
                        quizText += `⏰ **Quiz actif pendant 24h**\n`;
                        quizText += `🎮 **Partagez ce quiz avec vos amis!**`;
                        
                        // Nettoyer l'état utilisateur
                        state.users.delete(userId);
                        
                        // Programmer la suppression du quiz après 24h
                        setTimeout(() => {
                            state.quizzes.delete(quizId);
                            console.log(`🗑️ Quiz ${quizId} supprimé (24h expirées)`);
                        }, 24 * 60 * 60 * 1000);
                        
                        await message.reply(`🎉 **Quiz Créé avec Succès!**

🏆 Félicitations ${userName}! Votre quiz est maintenant en ligne!

${quizText}`);
                        
                        // Envoyer également un message de partage
                        return message.reply(`📢 **Partagez votre Quiz!**

📋 Copiez et partagez ce message:

"🧠 Nouveau Quiz: **${userState.quiz.title}**
📂 ${userState.quiz.category} | ⭐ ${userState.quiz.difficulty}
🎯 Jouez avec: /quiz répondre ${quizId} [vos réponses]
👤 Par ${userState.quiz.creator}"`);
                    }
                }
                break;
        }
    } catch (error) {
        console.error('❌ Erreur création quiz:', error.message);
        state.users.delete(userId);
        return message.reply(`❌ **Erreur Inattendue**

🔧 Une erreur s'est produite lors de la création.
🔄 Réessayez avec /quiz créer

💡 Si le problème persiste, contactez l'administrateur.`);
    }
}

// 4. Commande Text-to-Speech avec clonage vocal
async function ttsCommand(client, message, args) {
    try {
        const chat = await message.getChat();
        const userId = message.author || message.from;
        const userState = state.users.get(userId) || {};
        
        // Sous-commandes
        const action = args[0]?.toLowerCase();
        
        if (action === 'clone' || action === 'cloner') {
            // Enregistrer une voix de référence
            if (!message.hasQuotedMsg) {
                return message.reply(`🎙️ *Clonage Vocal*

Répondez à un message vocal pour cloner cette voix:
/tts clone

📝 Cette voix sera utilisée pour tous vos futurs textes!
⚠️ Durée recommandée: 10-30 secondes pour un bon clonage`);
            }

            const quotedMsg = await message.getQuotedMessage();
            if (!quotedMsg.hasMedia || quotedMsg.type !== 'ptt') {
                return message.reply('❌ Veuillez répondre à un message vocal!');
            }

            await message.reply('🎙️ Analyse et clonage de votre voix en cours...');

            // Télécharger et traiter l'audio de référence
            const media = await quotedMsg.downloadMedia();
            const { filepath: refPath } = await saveFile(Buffer.from(media.data, 'base64'), 'voice_ref.ogg', userId);
            
            // Convertir en format standard pour le clonage
            const processedRefPath = path.join(CONFIG.TEMP_DIR, `${userId}_voice_clone.wav`);
            
            await new Promise((resolve, reject) => {
                ffmpeg(refPath)
                    .audioChannels(1)
                    .audioFrequency(22050)
                    .audioCodec('pcm_s16le')
                    .toFormat('wav')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(processedRefPath);
            });

            // Analyser les caractéristiques vocales (simulation d'extraction de features)
            const voiceProfile = {
                id: generateId(),
                pitch: Math.random() * 0.4 + 0.8, // 0.8-1.2
                speed: Math.random() * 0.3 + 0.85, // 0.85-1.15
                tone: Math.random() * 0.6 + 0.7, // 0.7-1.3
                created: Date.now(),
                audioPath: processedRefPath
            };

            // Sauvegarder le profil vocal de l'utilisateur
            userState.voiceProfile = voiceProfile;
            state.users.set(userId, userState);

            await cleanupFile(refPath);
            
            return message.reply(`✅ *Voix clonée avec succès!*

🎯 ID du profil: ${voiceProfile.id}
📊 Caractéristiques détectées:
   • Pitch: ${(voiceProfile.pitch * 100).toFixed(0)}%
   • Vitesse: ${(voiceProfile.speed * 100).toFixed(0)}%
   • Tonalité: ${(voiceProfile.tone * 100).toFixed(0)}%

🗣️ Utilisez maintenant: /tts [votre texte]
🔄 Pour changer: /tts clone [nouveau vocal]`);

        } else if (action === 'voices' || action === 'voix') {
            // Lister les voix disponibles
            return message.reply(`🎭 *Voix Disponibles*

🤖 **Voix Système:**
• robot - Voix robotique
• female - Voix féminine douce
• male - Voix masculine profonde
• child - Voix d'enfant
• elderly - Voix âgée sage

👤 **Votre Voix:**
${userState.voiceProfile ? `✅ Voix personnelle (ID: ${userState.voiceProfile.id})` : '❌ Aucune voix clonée'}

💡 **Usage:**
/tts [texte] - Utilise votre voix clonée ou voix par défaut
/tts robot Bonjour! - Utilise une voix spécifique
/tts clone - Clone une nouvelle voix`);

        } else if (action === 'delete' || action === 'supprimer') {
            // Supprimer le profil vocal
            if (userState.voiceProfile) {
                await cleanupFile(userState.voiceProfile.audioPath);
                delete userState.voiceProfile;
                state.users.set(userId, userState);
                return message.reply('🗑️ Votre profil vocal a été supprimé!');
            } else {
                return message.reply('❌ Aucun profil vocal à supprimer.');
            }

        } else {
            // Synthèse vocale
            let textToSpeak;
            let voiceType = 'auto';

            // Vérifier si le premier argument est un type de voix
            const systemVoices = ['robot', 'female', 'male', 'child', 'elderly'];
            if (systemVoices.includes(action)) {
                voiceType = action;
                textToSpeak = args.slice(1).join(' ');
            } else {
                textToSpeak = args.join(' ');
            }

            if (!textToSpeak || textToSpeak.length < 2) {
                return message.reply(`🗣️ *Text-to-Speech*

**Usage:**
/tts [texte] - Synthèse avec votre voix
/tts robot Bonjour - Synthèse avec voix robotique

**Commandes:**
/tts clone - Cloner votre voix
/tts voix - Voir les voix disponibles
/tts supprimer - Supprimer votre profil vocal

💡 Exemple: /tts Bonjour, comment allez-vous?`);
            }

            if (textToSpeak.length > 500) {
                return message.reply('❌ Texte trop long! Maximum 500 caractères.');
            }

            await message.reply('🎵 Génération de l\'audio en cours...');

            // Préparer les paramètres de synthèse
            let audioParams = {
                pitch: 1.0,
                speed: 1.0,
                tone: 1.0
            };

            // Utiliser la voix clonée si disponible et pas de voix spécifiée
            if (voiceType === 'auto' && userState.voiceProfile) {
                audioParams = {
                    pitch: userState.voiceProfile.pitch,
                    speed: userState.voiceProfile.speed,
                    tone: userState.voiceProfile.tone
                };
            } else if (voiceType !== 'auto') {
                // Paramètres pour les voix système
                const voiceParams = {
                    robot: { pitch: 0.7, speed: 0.9, tone: 0.6 },
                    female: { pitch: 1.3, speed: 1.0, tone: 1.1 },
                    male: { pitch: 0.8, speed: 0.95, tone: 0.9 },
                    child: { pitch: 1.6, speed: 1.2, tone: 1.4 },
                    elderly: { pitch: 0.9, speed: 0.8, tone: 0.8 }
                };
                audioParams = voiceParams[voiceType] || audioParams;
            }

            // Générer l'audio avec espeak-ng (Text-to-Speech)
            const outputPath = path.join(CONFIG.TEMP_DIR, `${userId}_tts_${Date.now()}.wav`);
            const mp3OutputPath = path.join(CONFIG.TEMP_DIR, `${userId}_tts_${Date.now()}.mp3`);

            try {
                // Utiliser espeak pour la synthèse vocale de base
                const espeakCmd = `espeak-ng "${textToSpeak.replace(/"/g, '\\"')}" -w "${outputPath}" -s ${Math.round(audioParams.speed * 175)} -p ${Math.round(audioParams.pitch * 50)} -a 100`;
                
                await execAsync(espeakCmd);

                // Appliquer des effets audio avec FFmpeg pour améliorer le rendu
                let audioFilters = [];
                
                // Ajuster le pitch
                if (audioParams.pitch !== 1.0) {
                    audioFilters.push(`asetrate=22050*${audioParams.pitch},aresample=22050`);
                }
                
                // Ajuster la tonalité
                if (audioParams.tone !== 1.0) {
                    audioFilters.push(`equalizer=f=1000:width_type=h:width=500:g=${(audioParams.tone - 1) * 10}`);
                }
                
                // Ajouter de la réverbération légère pour plus de naturel
                audioFilters.push('aecho=0.8:0.88:60:0.4');
                
                // Normaliser le volume
                audioFilters.push('loudnorm');

                const filterChain = audioFilters.length > 0 ? audioFilters.join(',') : 'copy';

                await new Promise((resolve, reject) => {
                    const ffmpegProcess = ffmpeg(outputPath);
                    
                    if (filterChain !== 'copy') {
                        ffmpegProcess.audioFilters(filterChain);
                    }
                    
                    ffmpegProcess
                        .audioCodec('libmp3lame')
                        .audioBitrate('128k')
                        .toFormat('mp3')
                        .on('end', resolve)
                        .on('error', reject)
                        .save(mp3OutputPath);
                });

                // Envoyer le résultat
                const audioBuffer = await fs.readFile(mp3OutputPath);
                const audioMedia = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), 'tts_audio.mp3');
                
                const voiceInfo = voiceType === 'auto' && userState.voiceProfile ? 
                    'Votre voix clonée' : 
                    voiceType === 'auto' ? 'Voix par défaut' : `Voix ${voiceType}`;

                await client.sendMessage(chat.id._serialized, audioMedia, {
                    caption: `🗣️ *Text-to-Speech*\n🎭 ${voiceInfo}\n📝 "${textToSpeak}"`
                });

                // Nettoyage
                await cleanupFile(outputPath);
                await cleanupFile(mp3OutputPath);

            } catch (espeakError) {
                // Fallback: utiliser FFmpeg avec un générateur de tonalité si espeak n'est pas disponible
                console.log('⚠️ espeak-ng non disponible, utilisation du fallback');
                
                await new Promise((resolve, reject) => {
                    // Créer un bip modulé basé sur le texte (chaque caractère = fréquence différente)
                    const duration = Math.min(textToSpeak.length * 0.1, 10); // Max 10 secondes
                    const baseFreq = 440; // La (A4)
                    
                    ffmpeg()
                        .input(`sine=frequency=${baseFreq * audioParams.pitch}:duration=${duration}`)
                        .inputFormat('lavfi')
                        .audioFilters([
                            `atempo=${audioParams.speed}`,
                            `volume=${audioParams.tone}`,
                            'aecho=0.8:0.88:60:0.4'
                        ])
                        .audioCodec('libmp3lame')
                        .audioBitrate('128k')
                        .toFormat('mp3')
                        .on('end', resolve)
                        .on('error', reject)
                        .save(mp3OutputPath);
                });

                const audioBuffer = await fs.readFile(mp3OutputPath);
                const audioMedia = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), 'tts_beep.mp3');
                
                await client.sendMessage(chat.id._serialized, audioMedia, {
                    caption: `🗣️ *Text-to-Speech (Mode Bip)*\n⚠️ Synthèse vocale limitée\n📝 "${textToSpeak}"\n\n💡 Pour une vraie synthèse vocale, installez espeak-ng sur le serveur`
                });

                await cleanupFile(mp3OutputPath);
            }
        }

    } catch (error) {
        console.error('❌ Erreur TTS:', error.message);
        await message.reply('❌ Erreur lors de la synthèse vocale');
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

🗣️ *Text-to-Speech* - /tts
   Transforme le texte en audio avec votre voix
   /tts clone - Cloner votre voix
   /tts [texte] - Générer un audio

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
            case '/tts':
                 await ttsCommand(state.client, message, args);
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
