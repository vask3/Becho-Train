const myClientId = "aefd8b2f360ebfe5cab9f402d049139e";
const myClientSecret = "e087a444aec3004eae6a3a0e60f1942d";

const stationCodes = {
    "Berlin Hbf": "8011160",
    "München Hbf": "8000261",
    "Frankfurt Hbf": "8000105"
};

document.getElementById("checkButton").addEventListener("click", async function() {

    const selectedStation = document.getElementById("stationSelect").value;
    
    const stationCode = stationCodes[selectedStation];
    
    const resultBox = document.getElementById("apiResult");

    resultBox.innerHTML = `Loading data for ${selectedStation} (EVA: ${stationCode})... ⏳`;

    try {
        // DB API target URL
        const targetUrl = `https://apis.deutschebahn.com/db-api-marketplace/apis/stada/v2/stations/${stationCode}`;
        
        const proxyUrl = `https://api.allorigins.win/raw?url=` + encodeURIComponent(targetUrl);

        const response = await fetch(proxyUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'DB-Client-Id': myClientId,
                'DB-Api-Key': myClientSecret
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        
        resultBox.innerHTML = `<strong>Successfully connected to the Deutsche Bahn API! 🎉</strong><br>` +
                              `<pre>${JSON.stringify(data, null, 2)}</pre>`;

    } catch (error) {
        resultBox.innerHTML = `<span style="color: red;">Request error: ${error.message}</span><br>` +
                              `<small>Check if your Client ID/API Key are active.</small>`;
    }
});