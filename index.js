import * as Mastodon from 'tsl-mastodon-api';
import { convert } from 'html-to-text';
import OpenAI from "openai";

const READ_ONLY = false
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

async function passesModeration(lookingFor) {
    let input = lookingFor
    const moderation = await openai.moderations.create({ input: input });
    if(moderation.results.length !==0 && moderation.results[0].flagged) {
        console.log("Failed moderation")
        return false
    } 
    return true
}

const options = {
    wordwrap: 130,
    // ...
  };

async function getReply(userName, lookingFor) {
    const hasPassed = await passesModeration(lookingFor)

    if(!hasPassed) {
        return `@${userName} Sorry I can't help you with that request`
    }
    const functionName = "display_book_recommendation";
    const STRING_TYPE = "string";
    const OBJECT_TYPE = "object"
    const functions = [ {
        name: functionName,
        description: "Displays book recommendation",
        parameters: {
            type: OBJECT_TYPE,
            properties: {
                result: {
                    type: OBJECT_TYPE,
                    properties: {
                        title: {
                            type: STRING_TYPE,
                            description: "Book Title"
                        },
                        author: {
                            type: STRING_TYPE,
                            description: "Book Author"
                        },
                        reason: {
                            type: STRING_TYPE,
                            description: "Sales pitch to the user on why they will love the book. Limit to 60 words"
                        } 
                    },
                    required: ["title", 
                        "author", 
                        "reason"
                        ]
                }
            }
        }
    }]

    const chatResponse = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        messages: [
            {role: "system", "content": "Act as an expert librarian, tailoring book recommendations to user preferences without spoilers. Focus on understanding and matching the user's reading tastes, and ensure suggestions are personalized and engaging. Limit to single top response."},
            {role: "user", "content": "The user's search was: " + lookingFor},
        ],
        functions: functions,
        function_call: {name: functionName}
    });

    const bookRecommendationCall = chatResponse.choices[0].message.function_call
    if(!bookRecommendationCall || bookRecommendationCall.name !== functionName) {
        throw new Error("Failed to retrieve recommendation")
    }

    const recommendation = JSON.parse(bookRecommendationCall.arguments)
    const result = recommendation.result

    return `@${userName} Check out ${result.title} by ${result.author}\nWhy You'll Love This: ${result.reason}`
}

async function toot(mastodon, message, originStatusId) {
    if(READ_ONLY) {
        return
    }
    const postResult = await mastodon.postStatus({
        in_reply_to_id: originStatusId,
        status: message
    });
    if(postResult.failed) {
        console.error("Failed to reply:", postResult)
        throw new Error("Failed to post reply")
    }
}

async function dismissAllNotifications(mastodon) {
    if(READ_ONLY) {
        return
    }
    const dismissResult = await mastodon.postDismissAllNotifications()
    if(dismissResult.failed) {
        console.error("Failed to dismiss:", dismissResult)
        throw new Error("Failed to dismiss")
    }
}

async function replyToUsers() {
    const mastodon = new Mastodon.API({
        access_token: 'KiS_CLoCpCdXQQVDHoQCxu32OQkpc4XA0XV-zr5ITso',
        api_url: 'https://botsin.space/api/v1/'
    });
    try {
        const result = await mastodon.getNotifications();
        const notifications = result.json
        console.log(`Processing ${notifications.length} notifications`)
        for(let notification of notifications) {
            if(notification.type !== "mention") {
                continue
            }
            const userName = notification.account.acct
            try {
                const content = notification.status.content
                const plainTextContent = convert(content, options);
                console.log("Query:", plainTextContent)
                const id = notification.status.id
                const message = await getReply(userName, plainTextContent)
                await toot(mastodon, message, id)
                console.log("Response:", message)
            } catch (error) {
                console.error("Failed reply:", userName, error)
            }
            
        }
        await dismissAllNotifications(mastodon)
    }
    catch (error) {
        console.error("Failed to retrieve notifications or dismiss notifications", error);
    }
}
await replyToUsers();