#!/usr/bin/env python3
"""Generate 30 synthetic PDFs across 6 distinct domains for clustering benchmark.

Each domain has 5 documents with unique but thematically consistent content.
Domains are chosen to be maximally separable in embedding space.
"""

from fpdf import FPDF
import os

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "benchmark-clusters")

DOCUMENTS = {
    # Domain 1: Medical Research
    "medical": [
        {
            "title": "Cardiovascular Disease Risk Factors in Elderly Patients",
            "content": """Abstract: This retrospective cohort study examined cardiovascular disease risk factors among 2,847 patients aged 65 and older admitted to tertiary care hospitals between 2020 and 2024. Primary endpoints included myocardial infarction, stroke, and all-cause mortality.

Methods: Patient records were analyzed for hypertension, hyperlipidemia, diabetes mellitus type 2, smoking history, and body mass index. Multivariate logistic regression models adjusted for age, sex, and comorbidities.

Results: Hypertension was the strongest independent predictor of adverse cardiovascular events (OR 2.34, 95% CI 1.89-2.91, p<0.001). Patients with concurrent diabetes and hypertension showed a synergistic risk increase (OR 4.12, 95% CI 3.15-5.39). Statin therapy reduced 5-year mortality by 23% (HR 0.77, 95% CI 0.68-0.87).

Discussion: Our findings support aggressive blood pressure management in elderly populations. The combination of ACE inhibitors and calcium channel blockers showed superior outcomes compared to monotherapy. Renal function monitoring remains essential during antihypertensive treatment.

Conclusion: Early identification and management of modifiable risk factors significantly reduces cardiovascular morbidity and mortality in geriatric patients. Integrated care pathways combining pharmacological and lifestyle interventions are recommended."""
        },
        {
            "title": "Immunotherapy Response Biomarkers in Non-Small Cell Lung Cancer",
            "content": """Background: Immune checkpoint inhibitors have revolutionized treatment of non-small cell lung cancer (NSCLC), yet only 20-30% of patients achieve durable responses. Identifying predictive biomarkers remains a critical clinical need.

Methods: Tumor samples from 456 NSCLC patients treated with pembrolizumab or nivolumab were analyzed for PD-L1 expression (IHC 22C3), tumor mutational burden (TMB), microsatellite instability (MSI), and tumor-infiltrating lymphocyte (TIL) density. Next-generation sequencing identified somatic mutations across 468 cancer-related genes.

Results: High PD-L1 expression (TPS >= 50%) predicted objective response rate of 44.8% versus 17.1% for low expressors. TMB >= 10 mutations/Mb independently predicted progression-free survival (HR 0.58, p=0.002). Combined PD-L1 high and TMB high identified a subgroup with 62% response rate.

Pharmacokinetic Analysis: Serum drug concentrations correlated with response in a dose-dependent manner. Clearance was increased in patients with high tumor burden and liver metastases. Population pharmacokinetic modeling suggested weight-based dosing optimization.

Clinical Implications: A composite biomarker score integrating PD-L1, TMB, and TIL density provides superior predictive accuracy compared to individual markers. Liquid biopsy ctDNA monitoring enables early detection of acquired resistance."""
        },
        {
            "title": "Antibiotic Resistance Patterns in Hospital-Acquired Infections",
            "content": """Objective: To characterize antimicrobial resistance patterns among nosocomial pathogens isolated from intensive care unit patients across 12 academic medical centers during a 36-month surveillance period.

Microbiology Methods: Clinical isolates of Staphylococcus aureus, Pseudomonas aeruginosa, Klebsiella pneumoniae, and Acinetobacter baumannii were tested for susceptibility to 24 antimicrobial agents using broth microdilution per CLSI guidelines. Molecular typing was performed using whole-genome sequencing.

Key Findings: Methicillin-resistant S. aureus (MRSA) prevalence was 47.3%, with vancomycin MIC creep observed in 12% of isolates. Carbapenem-resistant Enterobacteriaceae (CRE) increased from 3.2% to 8.7% over the study period. Extended-spectrum beta-lactamase (ESBL) producing K. pneumoniae accounted for 31% of bloodstream infections.

Treatment Outcomes: Empiric combination therapy with meropenem plus colistin achieved 68% clinical cure rate for extensively drug-resistant (XDR) A. baumannii infections. De-escalation to targeted therapy within 72 hours was associated with reduced nephrotoxicity and shorter ICU length of stay.

Infection Control Measures: Implementation of enhanced hand hygiene protocols, contact precautions, and antimicrobial stewardship programs reduced overall healthcare-associated infection rates by 34% (p<0.001)."""
        },
        {
            "title": "Neurological Outcomes After Pediatric Traumatic Brain Injury",
            "content": """Study Design: Prospective longitudinal study following 312 children aged 2-16 years with moderate-to-severe traumatic brain injury (TBI) through 24 months of recovery. Glasgow Coma Scale scores at admission ranged from 3 to 12.

Neuroimaging Protocol: Serial MRI including diffusion tensor imaging (DTI), susceptibility-weighted imaging (SWI), and functional MRI (fMRI) were obtained at 2 weeks, 3 months, 6 months, 12 months, and 24 months post-injury. Fractional anisotropy (FA) values were measured in corpus callosum, internal capsule, and brainstem white matter tracts.

Cognitive Outcomes: Children with diffuse axonal injury (DAI) showed persistent deficits in processing speed (mean z-score -1.4 at 24 months), working memory (z-score -1.1), and executive function (z-score -0.9). Age at injury was a significant moderator, with children under 5 showing worse long-term outcomes.

Rehabilitation Interventions: Structured cognitive rehabilitation including attention training, memory strategies, and metacognitive skills training improved academic performance by 0.8 standard deviations. Physical therapy incorporating vestibular rehabilitation reduced post-concussive symptoms.

Prognostic Factors: Initial GCS score, pupillary reactivity, presence of epidural hematoma, and diffusion restriction patterns on early MRI were independent predictors of 12-month functional outcome (area under ROC curve = 0.87)."""
        },
        {
            "title": "Pharmacogenomics of Warfarin Dosing in Diverse Populations",
            "content": """Introduction: Warfarin remains the most widely prescribed oral anticoagulant worldwide, yet achieving therapeutic anticoagulation is complicated by significant inter-individual variability in dose requirements. Genetic polymorphisms in CYP2C9 and VKORC1 account for approximately 40% of dose variability.

Genetic Analysis: DNA samples from 1,823 patients initiating warfarin therapy were genotyped for CYP2C9*2, CYP2C9*3, CYP2C9*5, CYP2C9*6, CYP2C9*8, CYP2C9*11, VKORC1-1639G>A, CYP4F2 V433M, and GGCX rs11676382. Population-specific allele frequencies were compared across African American, European American, Hispanic, and Asian cohorts.

Dosing Algorithm Development: A machine learning-based dosing algorithm incorporating genetic, demographic, and clinical variables predicted maintenance dose within 20% of actual dose in 72% of patients, compared to 48% for clinical-only algorithms. Random forest models outperformed linear regression for patients requiring extreme doses.

Pharmacokinetic Modeling: Population pharmacokinetic analysis revealed CYP2C9*2 carriers had 37% reduced S-warfarin clearance, while CYP2C9*3 carriers showed 70% reduction. VKORC1 A/A genotype required 50% lower doses compared to G/G genotype. Drug interactions with amiodarone, fluconazole, and rifampin were quantified.

Clinical Implementation: Genotype-guided dosing reduced time to therapeutic INR by 4.2 days and decreased bleeding events by 31% compared to standard dosing. Cost-effectiveness analysis demonstrated savings of $1,200 per patient over 6 months of therapy."""
        },
    ],

    # Domain 2: Cooking & Recipes
    "cooking": [
        {
            "title": "Traditional French Pastry Techniques and Recipes",
            "content": """Chapter 1: Pate a Choux - The Foundation of French Pastry

The art of choux pastry begins with understanding the precise ratio of water, butter, flour, and eggs. For perfect choux, combine 250ml water, 100g unsalted butter, 5g salt, and 10g sugar in a heavy-bottomed saucepan. Bring to a rolling boil, ensuring all butter is melted before adding 150g sifted all-purpose flour in one addition.

Stir vigorously with a wooden spatula until the dough forms a smooth ball that pulls away from the sides of the pan. This cooking step, called dessecher, is critical for developing the structure. Cook for an additional 2 minutes to evaporate excess moisture.

Transfer to a stand mixer with paddle attachment. Add 4-5 large eggs one at a time, mixing thoroughly between additions. The finished dough should be glossy, smooth, and hold a stiff peak when pulled upward. Pipe immediately using a 1cm round tip onto parchment-lined baking sheets.

Bake at 200C for 15 minutes, then reduce to 180C for an additional 20 minutes. Do not open the oven door during baking. The puffs should be golden brown, hollow inside, and feel light when lifted.

Filling Options: Classic pastry cream (creme patissiere), diplomat cream, or savory fillings like gruyere bechamel. For profiteroles, fill with vanilla ice cream and drizzle with warm chocolate ganache made from 200g dark chocolate melted with 200ml heavy cream."""
        },
        {
            "title": "Southeast Asian Street Food Guide: Thai and Vietnamese Classics",
            "content": """Pad Thai - Bangkok Street Style

The secret to authentic pad thai lies in the sauce and the wok technique. Soak 200g flat rice noodles (sen lek) in room temperature water for 30 minutes until pliable but not soft.

Prepare the sauce: combine 3 tablespoons tamarind paste, 2 tablespoons fish sauce, 2 tablespoons palm sugar, and 1 tablespoon oyster sauce. Adjust sweetness and sourness to taste.

Heat a carbon steel wok over high flame until smoking. Add 3 tablespoons vegetable oil, swirl to coat. Stir-fry 200g peeled shrimp or sliced chicken breast for 2 minutes until nearly cooked. Push to one side, crack 2 eggs into the wok, scramble roughly.

Add drained noodles and sauce. Toss vigorously using a wok spatula and chopsticks simultaneously. The noodles should absorb the sauce within 2-3 minutes. Add 100g bean sprouts and 50g garlic chives, toss for 30 seconds.

Serve immediately garnished with crushed roasted peanuts, dried chili flakes, lime wedge, and additional bean sprouts. Never overcook the noodles or they become mushy.

Vietnamese Pho Bo (Beef Pho)

The broth is everything. Char 2 large onions and a 4-inch piece of ginger under the broiler until blackened. Toast whole spices in a dry pan: 3 star anise, 6 cloves, 1 cinnamon stick, 1 tablespoon coriander seeds, 1 teaspoon fennel seeds.

Simmer 2kg beef bones and 1kg oxtail in 4 liters water for 8 hours minimum. Skim impurities hourly. Add charred aromatics and toasted spices for the final 2 hours. Season with fish sauce and rock sugar. Strain through fine mesh."""
        },
        {
            "title": "Italian Bread Baking: Focaccia, Ciabatta, and Grissini",
            "content": """Focaccia Genovese - The Original

True Genoese focaccia requires a two-day process. Day one: prepare the biga (pre-ferment) by mixing 200g bread flour, 130ml water, and 1g instant yeast. Ferment at room temperature for 12-16 hours until doubled and bubbly.

Day two: Combine biga with 300g bread flour, 200ml water, 12g salt, 30ml extra virgin olive oil, and 3g instant yeast. Mix on low speed for 4 minutes, then medium for 6 minutes until windowpane stage. The dough should be very wet and sticky - this is correct.

Bulk fermentation: 2 hours at room temperature with stretch-and-folds every 30 minutes (4 total). Oil a 13x18 inch rimmed sheet pan generously. Turn dough onto pan, dimple with wet fingers, pushing to edges. Drizzle with 40ml olive oil. Proof 45 minutes.

Create deep dimples, scatter flaky sea salt and fresh rosemary. Bake at 220C for 22-25 minutes until deeply golden. The bottom should be crispy, the interior soft and airy with large irregular holes.

Ciabatta - Slipper Bread

Ciabatta demands very high hydration (80-85%) and careful handling to preserve the open crumb structure. Use bread flour with 12-13% protein content. Minimal kneading - rely on autolyse (45 minutes flour and water rest) and gentle folding during bulk fermentation."""
        },
        {
            "title": "Fermentation and Preservation: Kimchi, Sauerkraut, and Pickles",
            "content": """Chapter 3: Traditional Korean Kimchi

Napa Cabbage Kimchi (Baechu Kimchi)

Select 2 large, dense heads of napa cabbage (approximately 2kg each). Quarter lengthwise, keeping the core intact to hold leaves together. Dissolve 200g coarse sea salt in 2 liters water. Submerge cabbage, weighting down with a plate. Brine for 6-8 hours, turning once halfway through.

Prepare the kimchi paste (yangnyeom): blend 1 cup gochugaru (Korean red pepper flakes), 1/4 cup fish sauce, 3 tablespoons saeujeot (fermented shrimp paste), 8 cloves garlic, 1 tablespoon grated ginger, 2 tablespoons sugar, and 1/4 cup sweet rice flour paste. Add 200g julienned daikon radish, 100g scallions cut into 2-inch pieces, and 50g julienned carrots.

Rinse brined cabbage thoroughly three times. Squeeze out excess water. Spread paste between each leaf, working from outer leaves inward. Pack tightly into fermentation vessel (onggi, glass jar, or food-grade plastic container).

Fermentation timeline: Leave at room temperature (18-22C) for 24-48 hours until bubbling begins. Transfer to refrigerator where slow fermentation continues for 2-4 weeks. Peak flavor develops at 3-4 weeks. Kimchi continues to acidify over months, becoming more sour and complex.

Sauerkraut follows similar lacto-fermentation principles but uses only cabbage and salt (2% by weight). No additional ingredients needed - the naturally present Lactobacillus bacteria drive the fermentation."""
        },
        {
            "title": "Chocolate Tempering and Confectionery Arts",
            "content": """The Science of Chocolate Tempering

Proper tempering produces chocolate with a glossy sheen, satisfying snap, and smooth mouthfeel. Understanding the six polymorphic forms of cocoa butter crystals is essential. Only Form V (beta crystals, melting point 34C) produces stable, desirable chocolate.

Tabling Method: Melt dark chocolate (couverture, minimum 60% cacao) to 50-55C. Pour two-thirds onto a clean marble slab. Spread and gather repeatedly using a bench scraper and offset spatula until temperature drops to 27C. Return to remaining melted chocolate in bowl, stir to combine. Target working temperature: 31-32C for dark, 29-30C for milk, 27-28C for white.

Seeding Method: Melt chocolate to 50C. Remove from heat. Add finely chopped tempered chocolate (25-30% of total weight) while stirring continuously. The seed crystals act as nucleation sites for proper crystal formation. Stir until temperature reaches 31-32C.

Testing: Dip a knife blade or strip of parchment in tempered chocolate. At room temperature (20C), properly tempered chocolate should set within 3-5 minutes with a uniform glossy finish and no streaks or bloom.

Ganache Preparation: For truffles, heat 200ml cream to just below boiling. Pour over 300g finely chopped dark chocolate. Let stand 1 minute, then stir from the center outward in small circles to form a smooth emulsion. Add 30g soft butter for richness. Cool to 24C before piping."""
        },
    ],

    # Domain 3: Astrophysics & Space Science
    "astrophysics": [
        {
            "title": "Exoplanet Detection Methods and Atmospheric Characterization",
            "content": """Transit Photometry and the Kepler Legacy

The transit method remains the most prolific technique for exoplanet detection, with the Kepler and TESS missions discovering over 5,500 confirmed exoplanets. When a planet passes in front of its host star, the observed stellar flux decreases by a fraction proportional to the ratio of planetary to stellar cross-sectional areas: delta_F/F = (R_p/R_star)^2.

For a Jupiter-sized planet transiting a Sun-like star, the transit depth is approximately 1%, easily detectable with space-based photometry. Earth-sized planets produce transit depths of only 84 parts per million, requiring extraordinary photometric precision.

Transmission Spectroscopy: During transit, starlight filters through the planet's upper atmosphere, imprinting absorption features from atmospheric constituents. JWST has detected water vapor (H2O at 1.4 microns), carbon dioxide (CO2 at 4.3 microns), and sulfur dioxide (SO2) in the atmosphere of WASP-39b, a hot Jupiter at 700 light-years.

The habitable zone, where liquid water could exist on a planetary surface, depends on stellar luminosity. For M-dwarf stars (70% of all stars), the habitable zone lies at 0.1-0.4 AU, making planets susceptible to tidal locking and stellar flare activity.

Radial Velocity Confirmation: Transit candidates require radial velocity follow-up to measure true mass. The semi-amplitude K of the stellar reflex motion scales as M_p * sin(i) / M_star^(2/3), enabling mass-radius relationships that constrain interior composition models."""
        },
        {
            "title": "Black Hole Mergers and Gravitational Wave Astronomy",
            "content": """LIGO-Virgo-KAGRA Observations of Binary Black Hole Coalescence

Gravitational wave astronomy has opened an entirely new window on the universe since the first detection (GW150914) in September 2015. The observed waveform encodes the masses, spins, and orbital parameters of the merging compact objects.

Inspiral Phase: As two black holes orbit each other, they emit gravitational radiation that carries away energy and angular momentum, causing the orbit to shrink. The gravitational wave frequency increases as f_GW = 2 * f_orbital, sweeping through the LIGO sensitive band (10 Hz to several kHz) in the final seconds before merger.

The chirp mass, M_c = (m1 * m2)^(3/5) / (m1 + m2)^(1/5), is the best-measured parameter, determined from the rate of frequency evolution. For GW150914, M_c = 28.3 solar masses, implying component masses of approximately 36 and 29 solar masses.

Merger and Ringdown: The merger produces a single remnant black hole described by the Kerr solution, characterized entirely by mass and spin. Numerical relativity simulations are essential for modeling the strong-field dynamics near merger. The final black hole rings down through quasi-normal modes, with the dominant frequency determined by the remnant mass and spin.

Multi-Messenger Astronomy: The binary neutron star merger GW170817 was accompanied by a short gamma-ray burst (GRB 170817A) detected 1.7 seconds after merger, and a kilonova visible in optical and infrared wavelengths. This event confirmed neutron star mergers as a primary site of r-process nucleosynthesis."""
        },
        {
            "title": "Dark Matter Candidates and Direct Detection Experiments",
            "content": """The Dark Matter Problem in Modern Cosmology

Multiple independent lines of evidence establish that approximately 85% of the matter in the universe is non-luminous and non-baryonic. Galaxy rotation curves show flat velocity profiles at large radii, inconsistent with the expected Keplerian decline from visible matter alone. The cosmic microwave background (CMB) power spectrum constrains the dark matter density to Omega_DM * h^2 = 0.120 +/- 0.001.

Weakly Interacting Massive Particles (WIMPs): The WIMP miracle - that a particle with weak-scale mass (10 GeV to 10 TeV) and weak-scale interaction cross-section naturally produces the observed relic abundance - has motivated decades of direct detection experiments.

Xenon-Based Detectors: The XENONnT experiment at Gran Sasso National Laboratory uses 5.9 tonnes of liquid xenon as both target and detector medium. Nuclear recoils from WIMP-nucleus elastic scattering produce scintillation photons and ionization electrons detected by arrays of photomultiplier tubes. Current sensitivity reaches spin-independent cross-sections of 10^-47 cm^2 for a 30 GeV WIMP.

Axion Searches: The ADMX experiment searches for axions in the 1-40 microeV mass range using a tunable microwave cavity immersed in a strong magnetic field (7.6 Tesla). Axions convert to photons via the Primakoff effect, producing detectable microwave power proportional to the local axion density.

Alternative Candidates: Sterile neutrinos, primordial black holes, and self-interacting dark matter models address small-scale structure problems (missing satellites, core-cusp, too-big-to-fail) that challenge the collisionless cold dark matter paradigm."""
        },
        {
            "title": "Stellar Evolution and Nucleosynthesis in Massive Stars",
            "content": """Main Sequence to Supernova: The Life Cycle of Stars Above 8 Solar Masses

Massive stars burn through their nuclear fuel rapidly due to the steep temperature dependence of the CNO cycle (energy generation rate proportional to T^16). A 25 solar mass star exhausts its core hydrogen in approximately 7 million years, compared to 10 billion years for the Sun.

Hydrogen Burning: The pp-chain dominates in stars below 1.3 solar masses, while the CNO cycle becomes the primary energy source in more massive stars. Core temperatures exceed 15 million Kelvin, and central densities reach 150 g/cm^3 during main sequence evolution.

Advanced Burning Stages: After hydrogen exhaustion, the core contracts and heats until helium ignition at approximately 100 million Kelvin. The triple-alpha process converts three helium-4 nuclei into carbon-12, with subsequent alpha capture producing oxygen-16. These are the two most important products of stellar nucleosynthesis.

Subsequent burning stages proceed with increasingly short timescales: carbon burning (600 years), neon burning (1 year), oxygen burning (6 months), and silicon burning (1 day). The silicon burning shell produces iron-group elements (iron-56, nickel-56, cobalt-56), which have the highest binding energy per nucleon and cannot release energy through further fusion.

Core Collapse: When the iron core exceeds the Chandrasekhar mass (approximately 1.4 solar masses), electron degeneracy pressure can no longer support it. Collapse proceeds on a free-fall timescale of milliseconds, reaching nuclear density (2.3 x 10^14 g/cm^3). The bounce generates a shock wave that, energized by neutrino heating, explodes the stellar envelope as a Type II supernova."""
        },
        {
            "title": "Galaxy Formation and Large-Scale Structure of the Universe",
            "content": """Hierarchical Structure Formation in Lambda-CDM Cosmology

The standard cosmological model (Lambda-CDM) describes a universe dominated by dark energy (68%) and cold dark matter (27%), with ordinary baryonic matter comprising only 5% of the total energy density. Structure grows from primordial density fluctuations amplified by gravitational instability.

Linear Perturbation Theory: Small density perturbations (delta_rho/rho << 1) in an expanding universe grow proportionally to the scale factor during matter domination. The growth factor D(a) satisfies the linearized fluid equations, with dark energy suppressing growth at late times.

N-Body Simulations: The Millennium and IllustrisTNG simulations follow the evolution of dark matter particles and gas from redshift z=127 to the present, resolving halos from dwarf galaxy masses (10^8 solar masses) to massive galaxy clusters (10^15 solar masses). The cosmic web emerges naturally, with filaments, walls, and voids organized by the gravitational collapse of the initial density field.

Galaxy Formation Physics: Baryonic processes including gas cooling, star formation, supernova feedback, and active galactic nuclei (AGN) feedback regulate galaxy properties. The stellar mass function, color bimodality, and morphology-density relation emerge from the interplay of these processes within the dark matter halo framework.

Observational Constraints: Galaxy surveys (SDSS, DESI) measure the baryon acoustic oscillation (BAO) scale as a standard ruler, constraining the expansion history H(z). Weak gravitational lensing maps the projected dark matter distribution, testing structure growth predictions. Lyman-alpha forest spectra probe the intergalactic medium at high redshift."""
        },
    ],

    # Domain 4: Software Engineering
    "software": [
        {
            "title": "Microservices Architecture Patterns and Best Practices",
            "content": """Chapter 5: Service Communication Patterns

Synchronous Communication with gRPC

gRPC provides a high-performance RPC framework using Protocol Buffers for serialization and HTTP/2 for transport. Define service contracts in .proto files:

service OrderService {
  rpc CreateOrder (CreateOrderRequest) returns (OrderResponse);
  rpc GetOrder (GetOrderRequest) returns (OrderResponse);
  rpc ListOrders (ListOrdersRequest) returns (stream OrderResponse);
}

Server-side streaming enables efficient delivery of large datasets. Client-side load balancing with service discovery (Consul, etcd) eliminates single points of failure. Connection pooling and keep-alive settings optimize throughput.

Asynchronous Messaging with Apache Kafka

Event-driven architectures decouple producers from consumers using message brokers. Kafka topics are partitioned for parallel processing, with consumer groups providing load balancing across service instances.

Key design decisions: topic partitioning strategy (hash-based vs. range-based), retention policy (time-based or size-based), exactly-once semantics using idempotent producers and transactional consumers. Schema evolution managed through Confluent Schema Registry with Avro or Protobuf.

Circuit Breaker Pattern: Prevent cascade failures using Resilience4j or Hystrix. Track failure rates per downstream dependency. Open circuit after threshold exceeded, periodically allow test requests. Combine with bulkhead pattern (thread pool isolation) and rate limiting.

Saga Pattern for Distributed Transactions: Choreography-based sagas use events to coordinate multi-service workflows. Orchestration-based sagas use a central coordinator. Compensating transactions handle rollback scenarios. Choose choreography for simple flows, orchestration for complex workflows with conditional logic."""
        },
        {
            "title": "Database Sharding Strategies for High-Scale Applications",
            "content": """Horizontal Partitioning at Scale

Database sharding distributes data across multiple database instances to overcome single-node limitations in storage capacity, query throughput, and connection count.

Hash-Based Sharding: Apply a consistent hash function to the shard key (e.g., user_id) to determine target shard. Consistent hashing (virtual nodes on a hash ring) minimizes data movement during rebalancing. MurmurHash3 provides good distribution characteristics. Example: shard_id = murmur3(user_id) % num_shards.

Range-Based Sharding: Partition data by contiguous key ranges (e.g., date ranges, alphabetical). Simplifies range queries but creates hotspots if data distribution is skewed. Auto-splitting at configurable thresholds (e.g., 64GB per shard) maintains balance.

Directory-Based Sharding: A lookup table maps shard keys to physical shards, providing maximum flexibility at the cost of an additional lookup. Cache the directory in application memory with TTL-based invalidation.

Cross-Shard Queries: Scatter-gather pattern sends queries to all relevant shards and merges results. Fan-out increases latency linearly with shard count. Denormalization and materialized views reduce cross-shard joins. Global secondary indexes maintained via change data capture (CDC) streams.

Rebalancing Strategies: Online resharding using dual-write approach: write to both old and new locations during migration, switch reads after backfill completes, clean up old data. Vitess (MySQL), Citus (PostgreSQL), and CockroachDB provide built-in resharding capabilities.

Connection Management: Connection pooling per shard with PgBouncer or ProxySQL. Monitor per-shard connection counts, query latency percentiles (p50, p95, p99), and replication lag."""
        },
        {
            "title": "Continuous Integration Pipeline Design and Test Automation",
            "content": """Building Reliable CI/CD Pipelines

Pipeline Architecture: Multi-stage pipelines with quality gates ensure only validated artifacts reach production. Stage progression: lint -> unit test -> build -> integration test -> security scan -> staging deploy -> smoke test -> production deploy.

Test Pyramid Strategy:
- Unit tests (70%): Fast, isolated, mock external dependencies. Target < 5ms per test. Run on every commit. Frameworks: Jest, pytest, JUnit 5.
- Integration tests (20%): Verify component interactions with real databases (Testcontainers), message brokers, and external services. Test API contracts using Pact or Spring Cloud Contract.
- End-to-end tests (10%): Full system validation using Playwright or Cypress. Limit scope to critical user journeys. Parallelize across browser configurations.

Container-Based Build Environments: Docker-in-Docker or kaniko for building container images within CI. Multi-stage Dockerfiles minimize image size. Layer caching reduces build times by 60-80%.

Artifact Management: Semantic versioning with Git tags. Container images pushed to registry with immutable tags. Helm charts versioned independently from application code. Dependency scanning with Trivy or Grype before registry push.

Deployment Strategies: Blue-green deployments for zero-downtime releases. Canary deployments with gradual traffic shifting (1% -> 5% -> 25% -> 100%) based on error rate and latency metrics. Feature flags (LaunchDarkly, Unleash) for dark launches and A/B testing.

Observability Integration: Pipeline metrics exported to Prometheus/Grafana. Build duration, test pass rate, deployment frequency, and mean time to recovery (MTTR) tracked as DORA metrics. Flaky test detection and quarantine system."""
        },
        {
            "title": "Distributed Consensus Algorithms: Raft and Paxos",
            "content": """Raft Consensus Algorithm

Raft was designed as an understandable alternative to Paxos for managing a replicated log. The algorithm decomposes consensus into three subproblems: leader election, log replication, and safety.

Leader Election: Nodes begin as followers. If a follower receives no heartbeat within the election timeout (randomized between 150-300ms), it transitions to candidate state, increments its term, votes for itself, and requests votes from peers. A candidate winning majority votes becomes leader. Split votes resolved by randomized timeout retry.

Log Replication: The leader accepts client requests, appends entries to its log, and replicates them to followers via AppendEntries RPCs. An entry is committed when replicated to a majority of nodes. Followers apply committed entries to their state machines in log order.

Safety Properties: Election restriction ensures only candidates with up-to-date logs can win elections. A candidate's log must be at least as complete as any majority of logs. This guarantees the leader completeness property: if an entry is committed, it will be present in all future leaders' logs.

Membership Changes: Joint consensus approach handles configuration changes safely. The cluster first transitions to a joint configuration (old AND new), then to the new configuration. This prevents split-brain during transition.

Performance Characteristics: Write latency is bounded by one round-trip to majority (typically 1-5ms within a datacenter). Read linearizability requires either read-index protocol or lease-based reads. Throughput scales with batch size and pipeline depth.

Production Implementations: etcd (Kubernetes), CockroachDB, TiKV, and Consul all use Raft variants. Typical cluster sizes: 3 nodes (tolerates 1 failure), 5 nodes (tolerates 2 failures)."""
        },
        {
            "title": "Memory Management and Garbage Collection in Modern Runtimes",
            "content": """JVM Garbage Collection: From G1 to ZGC

Understanding heap memory management is critical for tuning Java application performance. The JVM divides the heap into generations: young generation (Eden + Survivor spaces), old generation (tenured), and metaspace (class metadata).

G1 Garbage Collector (default since Java 9): Divides heap into 2048 equal-sized regions. Young GC collects Eden and Survivor regions. Mixed GC additionally collects old regions with highest garbage-to-live ratio. Concurrent marking identifies garbage in old generation without stopping application threads (except brief STW pauses for initial-mark and remark).

Tuning parameters: -XX:MaxGCPauseMillis=200 (target pause time), -XX:G1HeapRegionSize=4m, -XX:InitiatingHeapOccupancyPercent=45. Monitor with GC logs: -Xlog:gc*:file=gc.log.

ZGC (Production-ready since Java 15): Designed for ultra-low latency (< 1ms pauses) with heaps up to 16TB. Uses colored pointers (metadata stored in unused pointer bits) and load barriers for concurrent relocation. No generational distinction in current implementation.

Key metrics: allocation rate (MB/s), promotion rate, GC frequency, pause duration distribution, and heap occupancy after GC. Tools: JFR (Java Flight Recorder), async-profiler, GCViewer.

Go Runtime Memory Management: Tri-color mark-and-sweep with write barriers. Concurrent GC runs alongside application goroutines. GOGC environment variable controls heap growth factor (default 100 = heap doubles before GC). Memory ballast technique pre-allocates unused memory to reduce GC frequency.

Rust Ownership Model: Compile-time memory management through ownership rules, borrowing, and lifetimes. No runtime GC overhead. Reference counting (Rc, Arc) for shared ownership. Box for heap allocation with deterministic deallocation at scope exit."""
        },
    ],

    # Domain 5: Real Estate & Property
    "realestate": [
        {
            "title": "Commercial Real Estate Valuation Methods",
            "content": """Income Approach to Property Valuation

The income capitalization approach is the primary valuation method for investment-grade commercial real estate. It converts anticipated future income into a present value estimate.

Direct Capitalization: Divide the property's net operating income (NOI) by the market-derived capitalization rate. Value = NOI / Cap Rate. For a Class A office building generating $2.5M annual NOI in a market with 6.0% cap rates, the indicated value is $41.67M.

Net Operating Income Calculation:
  Potential Gross Income (PGI): $3,200,000
  - Vacancy and Collection Loss (8%): ($256,000)
  = Effective Gross Income (EGI): $2,944,000
  - Operating Expenses: ($444,000)
    Property taxes: $180,000
    Insurance: $45,000
    Management fees (4%): $117,600
    Maintenance and repairs: $65,000
    Utilities: $36,400
  = Net Operating Income (NOI): $2,500,000

Discounted Cash Flow (DCF) Analysis: Project annual cash flows over a 10-year holding period, including rental income growth (2-3% annually), expense escalation, lease rollover assumptions, tenant improvement costs, and leasing commissions. Apply a terminal cap rate (typically 25-50 basis points above going-in cap rate) to year 11 NOI for reversion value. Discount all cash flows at the investor's required rate of return (IRR target: 8-12% for core assets, 15-20% for value-add).

Market Comparables: Adjust recent comparable sales for differences in location, age, condition, tenant quality, lease terms, and market conditions. Price per square foot analysis normalized for building class and submarket."""
        },
        {
            "title": "Residential Mortgage Underwriting Standards",
            "content": """Qualified Mortgage (QM) Guidelines Under CFPB Regulation

Debt-to-Income Ratio: The borrower's total monthly debt payments, including the proposed mortgage payment (PITI: principal, interest, taxes, insurance), must not exceed 43% of gross monthly income for General QM loans. Seasoned QM pathway allows higher DTI with compensating factors.

Income Documentation Requirements:
- W-2 employees: Two years of W-2 forms, recent pay stubs covering 30 days, verbal verification of employment
- Self-employed: Two years of federal tax returns (personal and business), year-to-date profit and loss statement, business bank statements (12 months)
- Rental income: Signed lease agreements, Schedule E from tax returns, minimum 75% of gross rent counted after vacancy factor

Credit Analysis: Minimum FICO score of 620 for conventional loans (Fannie Mae/Freddie Mac). FHA loans allow 580+ with 3.5% down payment, 500-579 with 10% down. Review credit report for late payments, collections, judgments, and bankruptcies. Minimum 2-year seasoning for Chapter 7 bankruptcy, 1 year for Chapter 13 with court approval.

Property Appraisal: Licensed appraiser must determine market value using sales comparison approach (minimum 3 comparable sales within 1 mile, sold within 6 months). Loan-to-value ratio determines PMI requirements: LTV > 80% requires private mortgage insurance. Appraisal must meet USPAP standards and Fannie Mae/Freddie Mac guidelines.

Reserves Verification: Borrowers must demonstrate liquid reserves sufficient for 2-6 months of mortgage payments (PITI) after closing. Acceptable sources include checking/savings accounts, retirement accounts (60% of vested value), and investment accounts. Gift funds require donor letter and paper trail."""
        },
        {
            "title": "Property Management Operations Manual",
            "content": """Tenant Relations and Lease Administration

Move-In Process: Complete property condition report with photographs before tenant occupancy. Document existing damage to prevent security deposit disputes. Provide tenant handbook covering building rules, maintenance request procedures, emergency contacts, and parking assignments.

Rent Collection: Due on the 1st of each month. Grace period through the 5th (market-dependent). Late fees of 5% of monthly rent assessed on the 6th. Three-day pay-or-quit notice issued after 10 days delinquency. Unlawful detainer action filed after notice period expires.

Maintenance Management: Emergency maintenance (fire, flood, gas leak, no heat in winter) requires response within 1 hour. Urgent maintenance (broken appliance, plumbing leak, HVAC failure) requires response within 24 hours. Routine maintenance (cosmetic repairs, non-essential items) addressed within 5 business days.

Preventive Maintenance Schedule:
  Monthly: HVAC filter replacement, common area inspection
  Quarterly: Pest control treatment, fire extinguisher inspection
  Semi-annually: Gutter cleaning, smoke/CO detector testing
  Annually: HVAC system service, roof inspection, parking lot sealcoating
  Every 5 years: Interior painting, carpet replacement, appliance refresh

Lease Renewal Process: Begin outreach 90 days before lease expiration. Market analysis to determine renewal rate (typically 3-5% annual increase). Present renewal offer 60 days before expiration. If tenant declines, begin marketing unit immediately with expected 30-day vacancy and $2,000-5,000 turnover cost (cleaning, painting, repairs).

Financial Reporting: Monthly owner reports including income statement, rent roll, delinquency report, maintenance log, and bank reconciliation. Annual budget preparation by October 1st for following year. Capital expenditure reserve funding at 3-5% of gross revenue."""
        },
        {
            "title": "Land Development and Zoning Compliance Guide",
            "content": """Site Planning and Entitlement Process

Preliminary Site Assessment: Before acquiring land for development, conduct Phase I Environmental Site Assessment (ESA) per ASTM E1527-21. Review historical land use, regulatory database searches, and site reconnaissance. Phase II ESA (soil and groundwater sampling) required if recognized environmental conditions (RECs) identified.

Zoning Analysis: Review municipal zoning code for permitted uses, conditional uses requiring special permits, and prohibited uses. Key metrics: Floor Area Ratio (FAR) determines maximum building size relative to lot area. A 10,000 SF lot with FAR 2.0 allows 20,000 SF of building. Setback requirements (front, side, rear) define building envelope. Height restrictions may be absolute (35 feet) or measured in stories (3 stories maximum).

Subdivision Approval Process:
1. Pre-application conference with planning department
2. Preliminary plat submission with engineering drawings
3. Environmental Impact Assessment (EIA) if required
4. Public hearing before Planning Commission
5. Final plat with conditions of approval incorporated
6. Recording of final plat with county recorder
7. Post-approval monitoring and compliance

Infrastructure Requirements: Developer responsible for constructing public improvements including roads (to AASHTO standards), water mains (per local utility specifications), sanitary sewer (gravity flow to treatment plant connection), storm drainage (detention/retention meeting post-development flow rates), sidewalks, street lighting, and landscaping within public right-of-way.

Impact Fees: One-time charges assessed at building permit issuance to fund off-site infrastructure improvements necessitated by new development. Typical fee categories: transportation ($3,000-$15,000 per residential unit), water/sewer ($2,000-$8,000), parks ($1,500-$5,000), schools ($3,000-$12,000), and fire/police ($500-$2,000)."""
        },
        {
            "title": "Real Estate Investment Trust (REIT) Analysis",
            "content": """REIT Financial Metrics and Performance Analysis

Funds from Operations (FFO): The primary earnings metric for REITs, defined by NAREIT as net income plus depreciation and amortization of real estate assets, excluding gains or losses from property sales. FFO per share is the REIT equivalent of earnings per share.

Adjusted Funds from Operations (AFFO): FFO minus recurring capital expenditures required to maintain property quality (maintenance capex), leasing commissions, and tenant improvement costs amortized over lease term. AFFO provides a more accurate measure of sustainable cash flow available for dividends.

Sample REIT Analysis:
  Net Income: $45,000,000
  + Real Estate Depreciation: $62,000,000
  + Amortization of Lease Intangibles: $8,000,000
  - Gain on Property Sale: ($12,000,000)
  = FFO: $103,000,000
  - Maintenance Capex: ($15,000,000)
  - Leasing Costs: ($7,000,000)
  = AFFO: $81,000,000

  Shares Outstanding: 50,000,000
  FFO/Share: $2.06
  AFFO/Share: $1.62
  Annual Dividend: $1.54/share (95% AFFO payout)

Net Asset Value (NAV): Sum of individual property values (using cap rate methodology) plus other assets minus liabilities. Premium/discount to NAV indicates market sentiment. Core REITs typically trade at 0-10% premium to NAV; distressed REITs may trade at 20-40% discount.

Sector Analysis: Office REITs facing headwinds from remote work (15-25% vacancy nationally). Industrial/logistics REITs benefit from e-commerce growth (4-5% rental rate increases). Data center REITs driven by AI infrastructure demand (power availability as key constraint). Healthcare REITs face demographic tailwinds from aging population."""
        },
    ],

    # Domain 6: Environmental Science & Climate
    "environmental": [
        {
            "title": "Ocean Acidification and Marine Ecosystem Impacts",
            "content": """The Chemistry of Ocean Acidification

Since the Industrial Revolution, the ocean has absorbed approximately 30% of anthropogenic carbon dioxide emissions, fundamentally altering seawater chemistry. The dissolution of CO2 in seawater forms carbonic acid (H2CO3), which dissociates to release hydrogen ions, lowering pH:

CO2 + H2O -> H2CO3 -> H+ + HCO3- -> 2H+ + CO3(2-)

Surface ocean pH has decreased from 8.21 to 8.10 (a 26% increase in hydrogen ion concentration) since pre-industrial times. Under high-emission scenarios (SSP5-8.5), pH could decline to 7.7 by 2100, representing a 150% increase in acidity.

Carbonate Chemistry: The saturation state (Omega) of calcium carbonate minerals (aragonite and calcite) decreases as pH falls. When Omega < 1, dissolution exceeds precipitation, threatening organisms that build calcium carbonate shells or skeletons. Current aragonite undersaturation already occurs in polar surface waters and deep ocean below the lysocline.

Biological Impacts: Coral reef calcification rates have declined 14% since 1990. Pteropods (sea butterflies) show shell dissolution in Southern Ocean waters. Oyster hatcheries in the Pacific Northwest experienced 80% larval mortality during acidification events. Fish olfactory systems are impaired, reducing predator avoidance behavior.

Ecosystem Cascades: Reduced coral reef structural complexity diminishes habitat for 25% of marine species. Weakened mollusk shells increase vulnerability to predation. Disrupted food webs from phytoplankton community shifts (diatoms replaced by smaller picophytoplankton) reduce energy transfer to higher trophic levels.

Mitigation Approaches: Ocean alkalinity enhancement (adding crushed olivine or lime) could locally increase pH. Seagrass and mangrove restoration enhances local CO2 uptake. Ultimately, reducing atmospheric CO2 emissions remains the only solution at scale."""
        },
        {
            "title": "Renewable Energy Grid Integration Challenges",
            "content": """Managing Variable Renewable Energy (VRE) at Scale

As wind and solar penetration exceeds 30% of total electricity generation, grid operators face fundamental challenges in maintaining reliability, stability, and power quality.

Duck Curve and Ramping Requirements: California's net load curve (total demand minus VRE generation) creates a deep midday trough followed by a steep evening ramp of 13 GW in 3 hours as solar generation declines. This requires flexible generation resources (natural gas peakers, hydroelectric, or battery storage) capable of rapid response.

Frequency Regulation: Conventional synchronous generators provide inertial response to frequency deviations through rotating mass. Inverter-based resources (solar, wind, batteries) do not inherently provide inertia. Grid-forming inverters with synthetic inertia algorithms are being developed, but widespread deployment remains years away.

Energy Storage Technologies:
- Lithium-ion batteries: 4-hour duration, $150-200/kWh (2024), 85-90% round-trip efficiency, 10-15 year lifespan, ~5000 cycles
- Pumped hydro storage: 8-12 hour duration, geographic constraints, 75-85% efficiency, 50+ year lifespan
- Compressed air energy storage (CAES): 8-24 hour duration, requires suitable geology, 60-70% efficiency
- Green hydrogen: seasonal storage potential, 30-40% round-trip efficiency (electrolysis + fuel cell), declining electrolyzer costs

Transmission Constraints: High-quality wind resources (Great Plains) and solar resources (Southwest) are distant from major load centers (coastal cities). HVDC transmission lines minimize losses over long distances (3-5% per 1000 km vs. 6-8% for HVAC). Permitting and construction timelines of 7-10 years for new transmission create bottlenecks.

Market Design: Wholesale electricity markets must evolve to properly value flexibility, capacity, and reliability services. Time-of-use pricing, real-time pricing, and demand response programs align consumer behavior with grid conditions."""
        },
        {
            "title": "Deforestation Monitoring Using Satellite Remote Sensing",
            "content": """Landsat and Sentinel-2 Based Forest Change Detection

Satellite remote sensing provides the only practical means of monitoring deforestation across the 4 billion hectares of global forest at sub-annual temporal resolution.

Optical Sensors: Landsat 8/9 (30m resolution, 16-day revisit) and Sentinel-2A/B (10m resolution, 5-day revisit) capture spectral reflectance in visible, near-infrared (NIR), and shortwave infrared (SWIR) bands. Forest clearing is detected by characteristic spectral changes: increased visible reflectance, decreased NIR reflectance, and increased SWIR reflectance as green canopy is replaced by bare soil.

Vegetation Indices: The Normalized Difference Vegetation Index (NDVI) = (NIR - Red) / (NIR + Red) distinguishes vegetated from non-vegetated surfaces. The Normalized Burn Ratio (NBR) = (NIR - SWIR2) / (NIR + SWIR2) detects fire-related forest loss. Enhanced Vegetation Index (EVI) reduces atmospheric and soil background effects in dense tropical forests.

Change Detection Algorithms: The Continuous Change Detection and Classification (CCDC) algorithm fits harmonic models to multi-year time series, identifying breaks that indicate land cover change. BFAST (Breaks for Additive Season and Trend) decomposes time series into seasonal, trend, and remainder components, detecting structural breaks.

Cloud Masking: Persistent cloud cover in tropical regions (Amazon, Congo Basin, Southeast Asia) creates data gaps. Sentinel-1 SAR (Synthetic Aperture Radar) operates independently of cloud cover and illumination, detecting forest clearing through backscatter changes. Multi-sensor fusion combines optical and SAR data for continuous monitoring.

Global Forest Watch: The University of Maryland's Global Forest Change dataset provides annual 30m resolution forest loss maps from 2000-present. Brazil's DETER system provides near-real-time alerts within 24 hours of clearing detection. GLAD alerts from Landsat achieve 90% user accuracy in tropical forests."""
        },
        {
            "title": "Microplastics in Freshwater Ecosystems",
            "content": """Sources, Transport, and Ecological Effects of Microplastic Pollution

Definition and Classification: Microplastics are synthetic polymer particles smaller than 5mm in their longest dimension. Primary microplastics are manufactured at small sizes (microbeads in cosmetics, pre-production pellets, textile fibers). Secondary microplastics result from fragmentation of larger plastic debris through UV photodegradation, mechanical abrasion, and biological degradation.

Freshwater Sources: Wastewater treatment plants discharge 1-100 microplastic particles per liter of effluent, with fibers from laundering synthetic textiles comprising 60-80% of particles. Urban stormwater runoff carries tire wear particles (TWP), road marking fragments, and litter-derived microplastics. Agricultural applications of sewage sludge (biosolids) introduce microplastics to soils, which subsequently wash into waterways.

Sampling Methodologies: Surface water sampling uses neuston nets (mesh size 300-333 micrometers) towed at 2-3 knots. Sediment samples collected with grab samplers and density-separated using ZnCl2 solution (1.6 g/cm^3). Water column sampling with submersible pumps and in-line filtration. All equipment must be verified plastic-free to prevent contamination.

Analytical Techniques: Visual identification under stereomicroscope (>500 micrometers) has high error rates. Micro-FTIR spectroscopy identifies polymer composition of particles >20 micrometers. Raman spectroscopy provides higher spatial resolution (>1 micrometer). Pyrolysis-GC/MS quantifies mass concentration but destroys particle morphology.

Ecological Effects: Laboratory studies demonstrate microplastic ingestion by freshwater invertebrates (Daphnia, Gammarus) at environmentally relevant concentrations. Effects include reduced feeding rates, decreased reproduction, oxidative stress, and altered gut microbiome. Microplastics serve as vectors for hydrophobic organic pollutants (PAHs, PCBs) and pathogenic bacteria, potentially increasing bioavailability of contaminants.

Concentrations: Lake surface waters: 0.01-100 particles/m^3. River water: 0.4-7000 particles/m^3. Lake sediments: 20-8000 particles/kg dry weight. Highest concentrations reported near urban areas and downstream of wastewater outfalls."""
        },
        {
            "title": "Carbon Capture and Geological Sequestration",
            "content": """Post-Combustion Carbon Capture Technology

Amine-Based Chemical Absorption: The most mature CCS technology uses aqueous monoethanolamine (MEA, 30 wt%) solution to absorb CO2 from flue gas in a packed absorption column at 40-60C. The CO2-rich solvent is pumped to a regeneration column (stripper) operating at 120C, where heat releases the CO2 for compression. Regenerated solvent is recycled.

Energy Penalty: Solvent regeneration requires 3.5-4.0 GJ of thermal energy per tonne of CO2 captured, reducing net power plant output by 25-40%. Advanced solvents (piperazine-promoted MDEA, ionic liquids) reduce energy requirements to 2.5-3.0 GJ/tonne. Process heat integration recovers waste heat from flue gas cooling and lean-rich heat exchange.

Capture Efficiency: Modern amine plants achieve 90-95% CO2 removal from flue gas containing 4-14% CO2 (by volume). Product CO2 purity exceeds 99.5% after dehydration, suitable for pipeline transport.

Geological Storage: CO2 is compressed to supercritical state (>74 bar, >31C) and injected into deep saline aquifers, depleted oil and gas reservoirs, or unmineable coal seams at depths exceeding 800 meters. At these depths, CO2 density approaches that of water, maximizing storage efficiency.

Trapping Mechanisms:
1. Structural/stratigraphic trapping: CO2 retained beneath impermeable caprock (primary mechanism, immediate)
2. Residual trapping: CO2 trapped as disconnected ganglia in pore spaces (years to decades)
3. Solubility trapping: CO2 dissolves in formation brine, increasing brine density (decades to centuries)
4. Mineral trapping: CO2 reacts with silicate minerals to form stable carbonates (centuries to millennia)

Monitoring: Time-lapse seismic surveys track CO2 plume migration. Pressure monitoring wells detect caprock integrity issues. Surface monitoring (eddy covariance, soil gas surveys) verifies no leakage. The Sleipner project (Norway) has safely stored 20+ million tonnes CO2 since 1996."""
        },
    ],
}


def create_pdf(title: str, content: str, output_path: str) -> None:
    """Create a simple text PDF from title and content."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=25)

    # Title
    pdf.set_font("Helvetica", "B", 16)
    pdf.multi_cell(0, 10, title)
    pdf.ln(10)

    # Content
    pdf.set_font("Helvetica", "", 11)
    for paragraph in content.strip().split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        # Check if it looks like a heading (short, no period at end)
        if len(paragraph) < 80 and not paragraph.endswith(".") and not paragraph.endswith(":"):
            pdf.set_font("Helvetica", "B", 13)
            pdf.multi_cell(0, 8, paragraph)
            pdf.set_font("Helvetica", "", 11)
        else:
            pdf.multi_cell(0, 6, paragraph)
        pdf.ln(4)

    pdf.output(output_path)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    total = 0
    for domain, docs in DOCUMENTS.items():
        for i, doc in enumerate(docs):
            filename = f"{domain}_{i+1:02d}.pdf"
            filepath = os.path.join(OUTPUT_DIR, filename)
            create_pdf(doc["title"], doc["content"], filepath)
            total += 1
            print(f"  Created: {filename} ({doc['title'][:60]})")

    print(f"\nTotal PDFs created: {total}")
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Domains: {list(DOCUMENTS.keys())}")
    print(f"Expected clusters: {len(DOCUMENTS)} (5 docs each)")


if __name__ == "__main__":
    main()
